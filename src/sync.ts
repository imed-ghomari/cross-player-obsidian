import {
    CrossPlayerSharedData,
    DeviceStateFile,
    MediaItem
} from './types';

export interface MergeDeviceStatesOptions {
    /** Returns true when the media path currently exists in the vault. */
    isPathPresent?: (path: string) => boolean;
    /** Optional filter for paths that belong to the active watched folder. */
    isPathAllowed?: (path: string) => boolean;
    /** Modification time of the file currently at path, if it exists. */
    getPathModifiedTime?: (path: string) => number | null | undefined;
    /** True when the path was intentionally recreated (e.g. a fresh download). */
    isRecreatedPath?: (path: string) => boolean;
    /** Device whose queue scroll position should be used. */
    localDeviceId?: string;
    /** Legacy tombstones from the old shared data.json. */
    legacyDeletedPaths?: Record<string, number>;
    /** Clock override for deterministic tests. */
    now?: number;
    maxTombstoneAgeMs?: number;
    /** How long a fresh delete wins over a sync-tool recreation. */
    tombstoneGuardMs?: number;
    /** Files modified within this margin of a delete are stale copies. */
    recreateToleranceMs?: number;
}

export interface MergedDeviceStates {
    queue: MediaItem[];
    deletedPaths: Record<string, number>;
    deletedFiles: Record<string, number>;
    queueUpdatedAt: number;
    queueScrollTop: number;
}

const DEFAULT_MAX_TOMBSTONE_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 200;
export const DEFAULT_DELETED_FILE_GUARD_MS = 5 * 60 * 1000;
export const DEFAULT_RECREATED_FILE_TOLERANCE_MS = 60 * 1000;

export interface FileDeletionAuthorityOptions {
    now?: number;
    guardMs?: number;
    recreateToleranceMs?: number;
    allowRecreated?: boolean;
}

/**
 * Decide whether an explicit file deletion should still win over a file that
 * currently exists at the same path.
 *
 * - A file older than the deletion is a stale copy restored by a sync tool.
 * - A file written right after the deletion is also treated as stale during
 *   a short guard window, because sync tools sometimes recreate files with a
 *   fresh modification time when resolving a conflict.
 * - After the guard window a genuinely newer file is an intentional
 *   re-download / re-import and is allowed back into the queue.
 */
export function isFileDeletionAuthoritative(
    deletedAt: number | undefined,
    fileModifiedAt: number | null | undefined,
    options: FileDeletionAuthorityOptions = {}
): boolean {
    if (deletedAt === undefined) return false;
    if (fileModifiedAt === null || fileModifiedAt === undefined) return true;
    if (options.allowRecreated) return false;

    const now = options.now ?? Date.now();
    const guardMs = options.guardMs ?? DEFAULT_DELETED_FILE_GUARD_MS;
    const toleranceMs = options.recreateToleranceMs ?? DEFAULT_RECREATED_FILE_TOLERANCE_MS;

    if (fileModifiedAt <= deletedAt + toleranceMs) return true;
    if (now - deletedAt < guardMs) return true;

    return false;
}

interface StateSnapshot {
    state: DeviceStateFile;
    order: number;
    items: Map<string, MediaItem>;
    queueOrder: string[];
}

interface ItemSnapshot {
    item: MediaItem;
    stateOrder: number;
    isBase: boolean;
}

function toFiniteNumber(value: unknown, fallback: number = 0): number {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function toNonNegativeNumber(value: unknown, fallback: number = 0): number {
    const parsed = toFiniteNumber(value, fallback);
    return parsed > 0 ? parsed : 0;
}

function normalizePath(path: unknown): string {
    if (typeof path !== 'string') return '';
    return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function baseName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
}

function normalizeStatus(value: unknown): MediaItem['status'] {
    if (value === 'completed' || value === 'playing' || value === 'pending') {
        return value;
    }
    return 'pending';
}

function stableIdForPath(path: string): string {
    // FNV-1a: deterministic across devices, so an item discovered
    // independently on two devices still gets the same local id.
    let hash = 0x811c9dc5;
    for (let i = 0; i < path.length; i++) {
        hash ^= path.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `m${(hash >>> 0).toString(36)}`;
}

function sanitizeItem(raw: unknown): MediaItem | null {
    if (!raw || typeof raw !== 'object') return null;

    const record = raw as Partial<MediaItem>;
    const path = normalizePath(record.path);
    if (!path) return null;

    const id = typeof record.id === 'string' && record.id
        ? record.id
        : stableIdForPath(path);
    const name = typeof record.name === 'string' && record.name
        ? record.name
        : baseName(path);

    return {
        id,
        path,
        name,
        status: normalizeStatus(record.status),
        finished: !!record.finished,
        position: toNonNegativeNumber(record.position),
        playbackUpdatedAt: toNonNegativeNumber(record.playbackUpdatedAt),
        duration: toNonNegativeNumber(record.duration),
        size: toNonNegativeNumber(record.size),
        countedAsConsumed: !!record.countedAsConsumed,
        consumedAt: typeof record.consumedAt === 'string' ? record.consumedAt : undefined
    };
}

function sanitizeStates(states: DeviceStateFile[]): StateSnapshot[] {
    const snapshots: StateSnapshot[] = [];

    for (const state of states) {
        if (!state || typeof state !== 'object') continue;
        const deviceId = typeof state.deviceId === 'string' ? state.deviceId : '';
        const queue = Array.isArray(state.queue) ? state.queue : [];

        const items = new Map<string, MediaItem>();
        const queueOrder: string[] = [];
        const seen = new Set<string>();

        for (const rawItem of queue) {
            const item = sanitizeItem(rawItem);
            if (!item) continue;
            if (seen.has(item.path)) continue;
            seen.add(item.path);
            items.set(item.path, item);
            queueOrder.push(item.path);
        }

        snapshots.push({
            state: {
                schemaVersion: toFiniteNumber(state.schemaVersion, 1),
                deviceId: deviceId || `unknown-${snapshots.length}`,
                deviceName: typeof state.deviceName === 'string' ? state.deviceName : undefined,
                updatedAt: toNonNegativeNumber(state.updatedAt),
                queueUpdatedAt: toNonNegativeNumber(state.queueUpdatedAt),
                queue: [],
                deletedPaths: state.deletedPaths && typeof state.deletedPaths === 'object'
                    ? state.deletedPaths
                    : {},
                deletedFiles: state.deletedFiles && typeof state.deletedFiles === 'object'
                    ? state.deletedFiles
                    : {},
                queueScrollTop: toNonNegativeNumber(state.queueScrollTop)
            },
            order: snapshots.length,
            items,
            queueOrder
        });
    }

    // Newest queue snapshot is the base for ordering. Ties are broken
    // deterministically by write time and device id so all devices converge.
    snapshots.sort((a, b) => {
        const queueDiff = (b.state.queueUpdatedAt || 0) - (a.state.queueUpdatedAt || 0);
        if (queueDiff !== 0) return queueDiff;
        const updatedDiff = (b.state.updatedAt || 0) - (a.state.updatedAt || 0);
        if (updatedDiff !== 0) return updatedDiff;
        return a.state.deviceId.localeCompare(b.state.deviceId);
    });

    return snapshots;
}

function addTombstone(
    target: Record<string, number>,
    path: string,
    timestamp: number
) {
    if (!path) return;
    const existing = target[path] || 0;
    if (timestamp > existing) {
        target[path] = timestamp;
    } else if (existing === 0) {
        target[path] = 0;
    }
}

function pruneTombstones(
    deleted: Record<string, number>,
    now: number,
    maxAgeMs: number
): Record<string, number> {
    const cutoff = now - maxAgeMs;
    const paths = Object.keys(deleted);

    for (const path of paths) {
        const timestamp = toNonNegativeNumber(deleted[path]);
        if (timestamp < cutoff) {
            delete deleted[path];
        }
    }

    // Keep the same bounded-growth behavior as the old data.json field.
    const remaining = Object.keys(deleted);
    if (remaining.length > MAX_TOMBSTONES) {
        remaining.sort((a, b) => (deleted[a] || 0) - (deleted[b] || 0));
        const removeCount = remaining.length - MAX_TOMBSTONES;
        for (let i = 0; i < removeCount; i++) {
            delete deleted[remaining[i]];
        }
    }

    return deleted;
}

function mergeItemSnapshots(
    path: string,
    snapshots: ItemSnapshot[]
): MediaItem {
    const baseSnapshot = snapshots.find(snapshot => snapshot.isBase) || snapshots[0];

    let latest = baseSnapshot;
    for (const snapshot of snapshots) {
        if (snapshot === baseSnapshot) continue;
        const snapshotTime = snapshot.item.playbackUpdatedAt || 0;
        const latestTime = latest.item.playbackUpdatedAt || 0;
        if (snapshotTime > latestTime) {
            latest = snapshot;
        }
    }

    let duration = 0;
    let size = 0;
    for (const snapshot of snapshots) {
        if (snapshot.item.duration > duration) duration = snapshot.item.duration;
        if ((snapshot.item.size || 0) > size) size = snapshot.item.size || 0;
    }

    const id = baseSnapshot.item.id
        || snapshots.map(snapshot => snapshot.item.id).find(value => !!value)
        || stableIdForPath(path);
    const name = baseSnapshot.item.name || latest.item.name || baseName(path);

    return {
        id,
        path,
        name,
        status: latest.item.status,
        finished: latest.item.finished,
        position: latest.item.position,
        playbackUpdatedAt: latest.item.playbackUpdatedAt,
        duration,
        size,
        countedAsConsumed: latest.item.countedAsConsumed,
        consumedAt: latest.item.consumedAt
    };
}

export function mergeDeviceStates(
    states: DeviceStateFile[],
    options: MergeDeviceStatesOptions = {}
): MergedDeviceStates {
    const now = options.now ?? Date.now();
    const maxTombstoneAgeMs = options.maxTombstoneAgeMs ?? DEFAULT_MAX_TOMBSTONE_AGE;
    const isPathPresent = options.isPathPresent;
    const isPathAllowed = options.isPathAllowed ?? (() => true);

    const snapshots = sanitizeStates(states);
    const deleted: Record<string, number> = {};
    const deletedFiles: Record<string, number> = {};

    for (const snapshot of snapshots) {
        const stateDeleted = snapshot.state.deletedPaths || {};
        for (const path of Object.keys(stateDeleted)) {
            addTombstone(deleted, normalizePath(path), toNonNegativeNumber(stateDeleted[path]));
        }

        const stateDeletedFiles = snapshot.state.deletedFiles || {};
        for (const path of Object.keys(stateDeletedFiles)) {
            addTombstone(deletedFiles, normalizePath(path), toNonNegativeNumber(stateDeletedFiles[path]));
        }
    }

    if (options.legacyDeletedPaths) {
        for (const path of Object.keys(options.legacyDeletedPaths)) {
            addTombstone(deleted, normalizePath(path), toNonNegativeNumber(options.legacyDeletedPaths[path]));
        }
    }

    pruneTombstones(deleted, now, maxTombstoneAgeMs);
    pruneTombstones(deletedFiles, now, maxTombstoneAgeMs);

    const shouldDropForTombstone = (path: string): boolean => {
        const pathDeletedAt = deleted[path];
        const fileDeletedAt = deletedFiles[path];
        if (pathDeletedAt === undefined && fileDeletedAt === undefined) return false;
        if (!isPathPresent) {
            // Without vault access (unit tests / migration), a tombstone is
            // treated as a confirmed delete.
            return true;
        }
        if (!isPathPresent(path)) {
            // Missing file + any tombstone = confirmed delete. A queue-only
            // tombstone must not remove a real file that still exists.
            return true;
        }
        if (fileDeletedAt === undefined) {
            return false;
        }
        return isFileDeletionAuthoritative(
            fileDeletedAt,
            options.getPathModifiedTime?.(path),
            {
                now,
                guardMs: options.tombstoneGuardMs,
                recreateToleranceMs: options.recreateToleranceMs,
                allowRecreated: options.isRecreatedPath?.(path)
            }
        );
    };

    const orderedPaths: string[] = [];
    const seenPaths = new Set<string>();
    const snapshotsByPath = new Map<string, ItemSnapshot[]>();

    const addPath = (path: string) => {
        if (!path || seenPaths.has(path)) return;
        if (!isPathAllowed(path)) return;
        if (shouldDropForTombstone(path)) return;
        seenPaths.add(path);
        orderedPaths.push(path);
    };

    for (let i = 0; i < snapshots.length; i++) {
        const snapshot = snapshots[i];
        for (const path of snapshot.queueOrder) {
            addPath(path);
        }
    }

    for (let stateOrder = 0; stateOrder < snapshots.length; stateOrder++) {
        const snapshot = snapshots[stateOrder];
        for (const path of snapshot.queueOrder) {
            if (!seenPaths.has(path)) continue;
            let items = snapshotsByPath.get(path);
            if (!items) {
                items = [];
                snapshotsByPath.set(path, items);
            }
            const item = snapshot.items.get(path);
            if (!item) continue;
            items.push({
                item,
                stateOrder,
                isBase: stateOrder === 0
            });
        }
    }

    const queue: MediaItem[] = [];
    for (const path of orderedPaths) {
        const items = snapshotsByPath.get(path);
        if (!items || items.length === 0) continue;
        items.sort((a, b) => a.stateOrder - b.stateOrder);
        queue.push(mergeItemSnapshots(path, items));
    }

    let queueUpdatedAt = 0;
    let queueScrollTop = 0;
    for (const snapshot of snapshots) {
        if ((snapshot.state.queueUpdatedAt || 0) > queueUpdatedAt) {
            queueUpdatedAt = snapshot.state.queueUpdatedAt || 0;
        }
        if (options.localDeviceId && snapshot.state.deviceId === options.localDeviceId) {
            queueScrollTop = snapshot.state.queueScrollTop || 0;
        }
    }

    return {
        queue,
        deletedPaths: deleted,
        deletedFiles,
        queueUpdatedAt,
        queueScrollTop
    };
}

export function buildSharedDataPayload(
    settings: CrossPlayerSharedData['settings'],
    playbackSpeed: number,
    consumptionStats: CrossPlayerSharedData['consumptionStats']
): CrossPlayerSharedData {
    return {
        settings,
        playbackSpeed,
        consumptionStats: consumptionStats || {}
    };
}
