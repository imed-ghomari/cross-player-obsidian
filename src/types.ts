export interface MediaItem {
    id: string;
    path: string;
    name: string;
    status: 'pending' | 'playing' | 'completed';
    finished?: boolean;
    position: number;
    playbackUpdatedAt?: number;
    duration: number;
    size?: number; // in bytes
    countedAsConsumed?: boolean;
    consumedAt?: string;
}

export interface ConsumptionStatBucket {
    seconds: number;
    completedCount: number;
}

export interface CrossPlayerSettings {
    watchedFolder: string;
    defaultPlaybackSpeed: number;
    speedPresets: string;
    sleepTimerPresets: string;
    seekSecondsForward: number;
    seekSecondsBackward: number;
    // YouTube Download Settings
    youtubeDlpPath: string;
    ffmpegPath: string;
    jsRuntimePath: string;
    downloadFolder: string;
    showMediaIndicator: boolean;
    storageLimitGB: number;
    autoplayNext: boolean;
    showProgressColor: boolean;
    pauseOnMobileTap: boolean;
    wrapQueueText: boolean;
    volumeBoostPercent: number;
    soundNormalization: boolean;
}

export interface DownloadStatus {
    id: string;
    name: string;
    progress: string;
    speed: string;
    eta: string;
    status: 'downloading' | 'paused' | 'converting' | 'completed' | 'error';
    error?: string;
    params?: {
        url: string;
        quality: string;
        type: 'video' | 'audio';
    };
}

export interface CrossPlayerData {
    settings: CrossPlayerSettings;
    queue: MediaItem[];
    queueUpdatedAt?: number;
    // Paths (vault-relative) removed from the queue on some device, with
    // removal timestamp (Date.now()). Used to stop stale peers from
    // resurrecting queue items. Entries older than 30 days are pruned.
    // A queue-only tombstone never deletes a file that still exists.
    deletedPaths?: Record<string, number>;
    // Paths whose file was explicitly deleted from disk on some device.
    // Peers use these tombstones to remove stale copies restored by a sync
    // tool. A genuinely newer file at the same path wins after the short
    // re-sync guard window.
    deletedFiles?: Record<string, number>;
    playbackSpeed: number;
    queueScrollTop?: number;
    consumptionStats?: Record<string, ConsumptionStatBucket>;
}

/**
 * Shared, low-frequency plugin data stored in data.json.
 * Queue and playback state deliberately live in per-device files instead:
 * writing them here made every 5-second progress save a whole-file
 * last-writer-wins race with sync tools.
 */
export interface CrossPlayerSharedData {
    settings: CrossPlayerSettings;
    playbackSpeed: number;
    consumptionStats?: Record<string, ConsumptionStatBucket>;
}

/**
 * One device's complete view of the queue and its local intents.
 * Only that device writes this file, so sync tools never have to merge two
 * writers for the same file.
 */
export interface DeviceStateFile {
    schemaVersion: number;
    deviceId: string;
    deviceName?: string;
    /** Time this snapshot was written (used only as a deterministic tie-break). */
    updatedAt: number;
    queueUpdatedAt?: number;
    queue: MediaItem[];
    deletedPaths?: Record<string, number>;
    deletedFiles?: Record<string, number>;
    queueScrollTop?: number;
}
