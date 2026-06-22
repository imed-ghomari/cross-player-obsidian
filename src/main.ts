import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, setIcon, Notice, TFolder, TFile, FuzzySuggestModal, TAbstractFile, Menu, Modal, Platform, debounce } from 'obsidian';
// import ffmpegStatic from 'ffmpeg-static';
import { MediaItem, CrossPlayerData, CrossPlayerSettings, DownloadStatus, ConsumptionStatBucket } from './types';
import Sortable from 'sortablejs';

interface ActiveDownload extends DownloadStatus {
    childProcess?: SpawnedProcess;
}

interface DeviceStatus {
    id: string;
    name: string;
    freeSpace: number; // in bytes
    timestamp: number;
}

interface StoredManifestData {
    id?: string;
    version?: string;
}

interface VaultAdapterWithBasePath {
    getBasePath(): string;
}

interface SpawnedProcessStream {
    on(event: 'data', callback: (data: Uint8Array | string) => void): void;
}

interface SpawnedProcess {
    stdout?: SpawnedProcessStream;
    stderr?: SpawnedProcessStream;
    on(event: 'error', callback: (error: Error) => void): void;
    on(event: 'close', callback: (code: number | null) => void): void;
    kill(): void;
}

type SpawnFunction = (
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined> }
) => SpawnedProcess;

interface ChildProcessModule {
    spawn: SpawnFunction;
}

interface AudioContextWindow extends Window {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
    require?: (moduleName: string) => unknown;
}

const VIEW_TYPE_CROSS_PLAYER_LIST = "cross-player-list-view";
const VIEW_TYPE_CROSS_PLAYER_MAIN = "cross-player-main-view";

const DEFAULT_SETTINGS: CrossPlayerSettings = {
    watchedFolder: '',
    defaultPlaybackSpeed: 2.0,
    seekSecondsForward: 10,
    seekSecondsBackward: 10,
    youtubeDlpPath: 'yt-dlp',
    ffmpegPath: '',
    jsRuntimePath: '',
    downloadFolder: '',
    showMediaIndicator: true,
    storageLimitGB: 10,
    autoplayNext: true,
    showProgressColor: true,
    pauseOnMobileTap: true,
    wrapQueueText: false,
    volumeBoostPercent: 100,
    soundNormalization: false
}

const LAST_WATCHED_FOLDER_KEY = 'cross-player:last-good-watched-folder';
const REQUIRED_PLUGIN_FILES = ['manifest.json', 'main.js'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'm4b', 'weba', 'aac', 'flac', 'aif', 'aiff', 'caf'];
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogv', 'mkv', '3gp'];
const SUPPORTED_MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

export default class CrossPlayerPlugin extends Plugin {
    data: CrossPlayerData;
    listView: CrossPlayerListView | null = null;
    mainView: CrossPlayerMainView | null = null;
    activeDownloads: ActiveDownload[] = [];
    debouncedReload: () => void = () => undefined;

    deviceId: string = '';
    deviceName: string = '';
    dynamicStorageLimit: number = 0; // bytes
    limitingDevice: string = '';

    debouncedUpdateDeviceStatus: () => void = () => undefined;
    lastSyncIssueKey: string = '';
    lastKnownDataMtime: number = 0;
    lastKnownDataSize: number = 0;
    isReloadingSyncedData: boolean = false;
    private saveDataChain: Promise<void> = Promise.resolve();
    private deferredMetadataPaths: Set<string> = new Set();
    private deferredMetadataTimer: number | null = null;
    private isHydratingDeferredMetadata: boolean = false;
    private pendingPlaybackStateKeys: Set<string> = new Set();

    private getLocalStorage(): Storage | null {
        if (typeof window === 'undefined') return null;
        return window.localStorage;
    }

    private getStoredString(key: string): string {
        try {
            return this.getLocalStorage()?.getItem(key) ?? '';
        } catch (error) {
            console.warn('[Cross Player] Failed to read local storage', error);
            return '';
        }
    }

    private setStoredString(key: string, value: string) {
        try {
            const storage = this.getLocalStorage();
            if (!storage) return;

            if (value) {
                storage.setItem(key, value);
            } else {
                storage.removeItem(key);
            }
        } catch (error) {
            console.warn('[Cross Player] Failed to write local storage', error);
        }
    }

    private getDesktopRequire(): AudioContextWindow['require'] | null {
        const runtimeWindow = window as AudioContextWindow;
        return typeof runtimeWindow.require === 'function' ? runtimeWindow.require : null;
    }

    private getMediaItemKeys(item: MediaItem): string[] {
        return [`id:${item.id}`, `path:${item.path}`];
    }

    markPlaybackStateChanged(item: MediaItem, timestamp: number = Date.now()) {
        item.playbackUpdatedAt = Math.max(item.playbackUpdatedAt || 0, timestamp);
        for (const key of this.getMediaItemKeys(item)) {
            this.pendingPlaybackStateKeys.add(key);
        }
    }

    private hasPendingPlaybackStateChange(item: MediaItem): boolean {
        return this.getMediaItemKeys(item).some(key => this.pendingPlaybackStateKeys.has(key));
    }

    private findMatchingQueueItem(queue: MediaItem[] | undefined, item: MediaItem): MediaItem | undefined {
        return queue?.find(candidate => candidate.id === item.id)
            || queue?.find(candidate => candidate.path === item.path);
    }

    private hasDifferentPlaybackState(a: MediaItem, b: MediaItem): boolean {
        return Math.abs((a.position || 0) - (b.position || 0)) > 1
            || a.status !== b.status
            || !!a.finished !== !!b.finished
            || !!a.countedAsConsumed !== !!b.countedAsConsumed
            || (a.consumedAt || '') !== (b.consumedAt || '');
    }

    private copyPlaybackState(target: MediaItem, source: MediaItem) {
        target.position = source.position || 0;
        target.status = source.status;
        target.finished = source.finished;
        target.countedAsConsumed = source.countedAsConsumed;
        target.consumedAt = source.consumedAt;
        target.playbackUpdatedAt = source.playbackUpdatedAt;
    }

    markQueueChanged() {
        this.data.queueUpdatedAt = Date.now();
    }

    private async mergeFresherPlaybackStateFromDisk() {
        const stat = await this.getPluginDataStat();
        const nextMtime = stat?.mtime ?? 0;
        const nextSize = stat?.size ?? 0;
        const changed = nextMtime !== this.lastKnownDataMtime || nextSize !== this.lastKnownDataSize;
        if (!changed) return;

        try {
            const dataText = await this.app.vault.adapter.read(this.getPluginDataPath());
            const diskData = (dataText.trim() ? JSON.parse(dataText) : {}) as Partial<CrossPlayerData>;
            if (!Array.isArray(diskData.queue)) return;

            const diskQueueUpdatedAt = diskData.queueUpdatedAt || 0;
            const localQueueUpdatedAt = this.data.queueUpdatedAt || 0;
            const diskQueueIsNewer = diskQueueUpdatedAt > localQueueUpdatedAt;

            if (diskQueueIsNewer) {
                for (const diskItem of diskData.queue) {
                    const localItem = this.findMatchingQueueItem(this.data.queue, diskItem);
                    if (!localItem) continue;

                    const diskPlaybackUpdatedAt = diskItem.playbackUpdatedAt || 0;
                    const localPlaybackUpdatedAt = localItem.playbackUpdatedAt || 0;
                    const diskIsNewer = diskPlaybackUpdatedAt > localPlaybackUpdatedAt;
                    const localChangedPlayback = this.hasPendingPlaybackStateChange(localItem);

                    if (!diskIsNewer && (localPlaybackUpdatedAt > diskPlaybackUpdatedAt || localChangedPlayback)) {
                        this.copyPlaybackState(diskItem, localItem);
                    }

                    if ((!diskItem.duration || diskItem.duration <= 0) && localItem.duration && localItem.duration > 0) {
                        diskItem.duration = localItem.duration;
                    }

                    if (!diskItem.size && localItem.size) {
                        diskItem.size = localItem.size;
                    }
                }
                this.data.queue = diskData.queue;
                this.data.queueUpdatedAt = diskQueueUpdatedAt;
            } else {
                for (const localItem of this.data.queue) {
                    const diskItem = this.findMatchingQueueItem(diskData.queue, localItem);
                    if (!diskItem) continue;

                    const diskPlaybackUpdatedAt = diskItem.playbackUpdatedAt || 0;
                    const localPlaybackUpdatedAt = localItem.playbackUpdatedAt || 0;
                    const diskIsNewer = diskPlaybackUpdatedAt > localPlaybackUpdatedAt;
                    const localChangedPlayback = this.hasPendingPlaybackStateChange(localItem);

                    if (diskIsNewer || (!localChangedPlayback && this.hasDifferentPlaybackState(localItem, diskItem))) {
                        this.copyPlaybackState(localItem, diskItem);
                    }

                    if ((!localItem.duration || localItem.duration <= 0) && diskItem.duration && diskItem.duration > 0) {
                        localItem.duration = diskItem.duration;
                    }

                    if (!localItem.size && diskItem.size) {
                        localItem.size = diskItem.size;
                    }
                }
            }

            if (diskData.consumptionStats) {
                this.data.consumptionStats = Object.assign({}, diskData.consumptionStats, this.data.consumptionStats ?? {});
            }
        } catch (error) {
            console.warn('[Cross Player] Failed to merge synced playback state before save', error);
        }
    }

    private loadDesktopModule<T>(moduleParts: string[]): T | null {
        const desktopRequire = this.getDesktopRequire();
        if (!desktopRequire) return null;

        try {
            return desktopRequire(moduleParts.join('')) as T;
        } catch (error) {
            console.warn('[Cross Player] Failed to load desktop module', error);
            return null;
        }
    }

    private getSpawnFunction(): SpawnFunction | null {
        const childProcessModule = this.loadDesktopModule<ChildProcessModule>(['child', '_', 'process']);
        return childProcessModule?.spawn ?? null;
    }

    private getVaultBasePath(): string | null {
        const adapter = this.app.vault.adapter as Partial<VaultAdapterWithBasePath>;
        return typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null;
    }

    private buildAbsoluteVaultPath(relativePath: string): string | null {
        const basePath = this.getVaultBasePath();
        if (!basePath) return null;
        const normalizedBase = basePath.replace(/[\\/]+$/, '');
        const normalizedRelative = relativePath.replace(/^[/\\]+/, '');
        return normalizedRelative ? `${normalizedBase}/${normalizedRelative}` : normalizedBase;
    }

    getLastGoodWatchedFolder(): string {
        return this.getStoredString(LAST_WATCHED_FOLDER_KEY);
    }

    setLastGoodWatchedFolder(path: string) {
        this.setStoredString(LAST_WATCHED_FOLDER_KEY, path);
    }

    isPathInsideWatchedFolder(path: string, watchedFolder: string = this.data?.settings?.watchedFolder ?? ''): boolean {
        if (!watchedFolder) return true;
        return path === watchedFolder || path.startsWith(watchedFolder + '/');
    }

    private collectMediaFiles(folder: TFolder): TFile[] {
        const files: TFile[] = [];

        const visitFolder = (currentFolder: TFolder) => {
            for (const child of currentFolder.children) {
                if (child instanceof TFile) {
                    files.push(child);
                } else if (child instanceof TFolder) {
                    visitFolder(child);
                }
            }
        };

        visitFolder(folder);
        return files;
    }

    getVaultFolders(): TFolder[] {
        const folders: TFolder[] = [];

        const visitFolder = (currentFolder: TFolder) => {
            folders.push(currentFolder);
            for (const child of currentFolder.children) {
                if (child instanceof TFolder) {
                    visitFolder(child);
                }
            }
        };

        visitFolder(this.app.vault.getRoot());
        return folders;
    }

    rememberQueueScrollPosition() {
        this.listView?.captureScrollPosition();
    }

    async reportSyncIssue(issueKey: string, message: string) {
        if (this.lastSyncIssueKey === issueKey) return;
        this.lastSyncIssueKey = issueKey;
        new Notice(message, 9000);
    }

    clearSyncIssue(issueKey?: string) {
        if (!issueKey || this.lastSyncIssueKey === issueKey) {
            this.lastSyncIssueKey = '';
        }
    }

    getPluginDataPath() {
        return `${this.manifest.dir}/data.json`;
    }

    async getPluginDataStat() {
        try {
            return await this.app.vault.adapter.stat(this.getPluginDataPath());
        } catch (error) {
            console.warn('[Cross Player] Failed to stat data.json', error);
            return null;
        }
    }

    async refreshTrackedDataFileState() {
        const stat = await this.getPluginDataStat();
        this.lastKnownDataMtime = stat?.mtime ?? 0;
        this.lastKnownDataSize = stat?.size ?? 0;
    }

    async reloadSyncedDataIfChanged(force: boolean = false) {
        if (this.isReloadingSyncedData) return;

        const stat = await this.getPluginDataStat();
        const nextMtime = stat?.mtime ?? 0;
        const nextSize = stat?.size ?? 0;
        const changed = force || nextMtime !== this.lastKnownDataMtime || nextSize !== this.lastKnownDataSize;

        if (!changed) return;

        this.isReloadingSyncedData = true;
        try {
            await this.loadData();
            await this.validatePluginSyncHealth();
            await this.refreshTrackedDataFileState();

            if (this.mainView) {
                this.mainView.handleSyncedDataReload();
            }

            if (this.listView) {
                this.listView.refresh();
            }
        } finally {
            this.isReloadingSyncedData = false;
        }
    }

    async validatePluginSyncHealth() {
        try {
            const adapter = this.app.vault.adapter;
            const pluginDir = this.manifest.dir;

            for (const fileName of REQUIRED_PLUGIN_FILES) {
                const filePath = `${pluginDir}/${fileName}`;
                if (!(await adapter.exists(filePath))) {
                    await this.reportSyncIssue(
                        `missing:${fileName}`,
                        `Cross Player sync issue: ${fileName} is missing. The plugin may not be fully synced on this device.`
                    );
                    return;
                }
            }

            const manifestText = await adapter.read(`${pluginDir}/manifest.json`);
            const manifest = JSON.parse(manifestText) as StoredManifestData;
            if (!manifest?.id || !manifest?.version) {
                await this.reportSyncIssue(
                    'invalid:manifest',
                    'Cross Player sync issue: manifest.json looks incomplete. The plugin may not be fully synced on this device.'
                );
                return;
            }

            const dataPath = `${pluginDir}/data.json`;
            const hasDataFile = await adapter.exists(dataPath);
            const backupWatchedFolder = this.getLastGoodWatchedFolder();

            if (!hasDataFile) {
                if (backupWatchedFolder || (this.data?.queue?.length ?? 0) > 0) {
                    await this.reportSyncIssue(
                        'missing:data',
                        'Cross Player sync issue: data.json is missing, so synced settings may be incomplete on this device.'
                    );
                    return;
                }

                this.clearSyncIssue('missing:data');
                return;
            }

            const dataText = await adapter.read(dataPath);
            const parsed = (dataText.trim() ? JSON.parse(dataText) : {}) as Partial<CrossPlayerData>;
            if (typeof parsed !== 'object' || parsed === null) {
                await this.reportSyncIssue(
                    'invalid:data',
                    'Cross Player sync issue: data.json could not be read correctly. Settings may be partially synced.'
                );
                return;
            }

            if (backupWatchedFolder && !parsed.settings?.watchedFolder) {
                await this.reportSyncIssue(
                    'incomplete:data',
                    'Cross Player sync issue: data.json is missing the watched folder. A local backup was restored on this device.'
                );
                return;
            }

            this.clearSyncIssue();
        } catch (error) {
            console.error('[Cross Player] Failed to validate plugin sync health', error);
            await this.reportSyncIssue(
                'check:failed',
                'Cross Player could not verify its synced files. This device may have an incomplete plugin sync.'
            );
        }
    }

    async onload() {
        await this.loadData();
        await this.refreshTrackedDataFileState();
        await this.validatePluginSyncHealth();
        await this.calculateDynamicLimit();

        // ffmpeg-static is removed because it causes issues on mobile (bundling Node-only code).
        // Users should install ffmpeg systematically.

        // Debounced update for device status
        this.debouncedUpdateDeviceStatus = debounce(async () => {
            await this.updateDeviceStatus();
        }, 2000, true);

        this.addCommand({
            id: 'test-yt-dlp',
            name: 'Test yt-dlp Configuration',
            callback: async () => {
                if (!Platform.isDesktop) {
                    new Notice("This command is only available on Desktop.");
                    return;
                }

                const { youtubeDlpPath } = this.data.settings;
                const ytPath = youtubeDlpPath.trim();
                new Notice(`Testing yt-dlp at: ${ytPath}`);

                try {
                    const spawn = this.getSpawnFunction();
                    if (!spawn) {
                        new Notice('Desktop process access is unavailable in this build.');
                        return;
                    }

                    // Fix PATH for macOS GUI
                    const env = { ...process.env };
                    if (Platform.isDesktop && process.platform === 'darwin') {
                        const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
                        env.PATH = extraPaths.join(':') + (env.PATH ? ':' + env.PATH : '');
                    }

                    const { jsRuntimePath } = this.data.settings;
                    const testArgs = ['--version'];
                    if (jsRuntimePath) {
                        testArgs.push('--js-runtimes', `node:${jsRuntimePath}`);
                    } else {
                        testArgs.push('--js-runtimes', 'node');
                    }

                    const child = spawn(ytPath, testArgs, { env });
                    child.stdout?.on('data', (data: Uint8Array | string) => {
                        const version = data.toString().trim();
                        new Notice(`yt-dlp version: ${version}`);
                        // Simple check: if version starts with 2021, 2022, 2023, it's likely too old given it's 2025+
                        if (version.startsWith('2021') || version.startsWith('2022') || version.startsWith('2023')) {
                            new Notice("⚠️ Your yt-dlp is very old! Please update it.");
                        }
                    });
                    child.stderr?.on('data', (data: Uint8Array | string) => {
                        new Notice(`yt-dlp error: ${data.toString()}`);
                    });
                    child.on('error', (err: Error) => {
                        new Notice(`Failed to run yt-dlp: ${err.message}`);
                    });

                    // Also check ffmpeg if configured
                    const { ffmpegPath } = this.data.settings;
                    if (ffmpegPath) {
                        const ffmpegChild = spawn(ffmpegPath, ['-version'], { env });
                        ffmpegChild.on('error', () => {
                            new Notice(`⚠️ FFmpeg not found at: ${ffmpegPath}`);
                        });
                        ffmpegChild.stdout?.on('data', (data: Uint8Array | string) => {
                            if (data.toString().includes('ffmpeg version')) {
                                // detected
                            }
                        });
                    }

                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error';
                    new Notice(`Exception: ${message}`);
                }
            }
        });

        this.addSettingTab(new CrossPlayerSettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE_CROSS_PLAYER_LIST,
            (leaf) => new CrossPlayerListView(leaf, this)
        );

        this.registerView(
            VIEW_TYPE_CROSS_PLAYER_MAIN,
            (leaf) => new CrossPlayerMainView(leaf, this)
        );

        this.addRibbonIcon('play-circle', 'Open Cross Player', () => {
            void this.activateListView();
        });

        this.addCommand({
            id: 'clean-consumed-media',
            name: 'Clean Consumed Media',
            callback: () => new ConfirmCleanConsumedMediaModal(this.app, this).open()
        });

        this.addCommand({
            id: 'open-player',
            name: 'Open Player',
            callback: () => {
                void this.activateListView();
            }
        });

        this.addCommand({
            id: 'set-watched-folder',
            name: 'Set Watched Folder',
            callback: () => {
                new FolderSuggestModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: 'increase-playback-speed',
            name: 'Increase Playback Speed',
            callback: () => {
                if (this.mainView) void this.mainView.changePlaybackSpeed(0.1);
            }
        });

        this.addCommand({
            id: 'decrease-playback-speed',
            name: 'Decrease Playback Speed',
            callback: () => {
                if (this.mainView) void this.mainView.changePlaybackSpeed(-0.1);
            }
        });

        this.addCommand({
            id: 'seek-forward',
            name: 'Seek Forward',
            callback: () => {
                if (this.mainView) {
                    this.mainView.seek(this.data.settings.seekSecondsForward);
                }
            }
        });

        this.addCommand({
            id: 'seek-backward',
            name: 'Seek Backward',
            callback: () => {
                if (this.mainView) {
                    this.mainView.seek(-this.data.settings.seekSecondsBackward);
                }
            }
        });

        this.addCommand({
            id: 'delete-current-file',
            name: 'Delete Current File',
            callback: () => this.deleteCurrentFile()
        });

        this.addCommand({
            id: 'play-next-file',
            name: 'Go to Next File',
            callback: () => this.playNextItem()
        });

        this.addCommand({
            id: 'play-previous-file',
            name: 'Go to Previous File',
            callback: () => this.playPreviousItem()
        });

        this.addCommand({
            id: 'set-current-unread',
            name: 'Set Current File as Unread',
            callback: () => this.setCurrentAsUnread()
        });

        this.addCommand({
            id: 'refresh-watched-folder',
            name: 'Refresh Watched Folder',
            callback: () => {
                if (this.data.settings.watchedFolder) {
                    void this.scanFolder(this.data.settings.watchedFolder);
                    new Notice("Watched folder refreshed.");
                } else {
                    new Notice("No watched folder set.");
                }
            }
        });

        this.addCommand({
            id: 'download-youtube-video',
            name: 'Download YouTube Video',
            callback: () => {
                new YouTubeDownloadModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: 'reload-data',
            name: 'Reload Data from Disk',
            callback: async () => {
                await this.reloadSyncedDataIfChanged(true);
                new Notice("Data reloaded.");
            }
        });

        this.addCommand({
            id: 'toggle-fullscreen',
            name: 'Toggle Fullscreen',
            callback: () => {
                if (this.mainView) {
                    this.mainView.toggleFullscreen();
                } else {
                    new Notice("Open a media file first.");
                }
            }
        });

        this.addCommand({
            id: 'toggle-subtitles',
            name: 'Toggle Subtitles On/Off',
            callback: () => {
                if (this.mainView) {
                    this.mainView.toggleSubtitles();
                } else {
                    new Notice("Open a media file first.");
                }
            }
        });

        this.addCommand({
            id: 'switch-subtitle-track',
            name: 'Switch Subtitle Track',
            callback: () => {
                if (this.mainView) {
                    this.mainView.switchSubtitleTrack();
                } else {
                    new Notice("Open a media file first.");
                }
            }
        });

        this.debouncedReload = debounce(async () => {
            await this.reloadSyncedDataIfChanged();
        }, 1000, true);

        // Also reload when window gains focus (best for switching devices)
        this.registerDomEvent(window, 'focus', () => {
            this.debouncedReload();
        });
        this.registerDomEvent(activeDocument, 'visibilitychange', () => {
            if (activeDocument.visibilityState === 'visible') {
                this.debouncedReload();
            }
        });
        this.registerInterval(window.setInterval(() => {
            this.debouncedReload();
        }, 5000));

        this.registerWatchers();

        if (this.data.settings.watchedFolder) {
            void this.scanFolder(this.data.settings.watchedFolder);
        }

        // Initialize Device Status
        await this.loadDeviceId();
        void this.updateDeviceStatus();

        // Removed interval check as requested, relying on file events
    }

    onunload() {}

    async loadDeviceId() {
        // Try to load from localStorage
        let id = this.getStoredString('cross-player-device-id');
        if (!id) {
            id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
            this.setStoredString('cross-player-device-id', id);
        }
        this.deviceId = id;

        // Set device name
        let name = Platform.isMobile ? "Mobile" : "Desktop";
        if (!Platform.isDesktop) {
            if (Platform.isIosApp) name = "iPad/iPhone";
            if (Platform.isAndroidApp) name = "Android";
        }
        this.deviceName = name;
    }

    async getFreeSpace(): Promise<number> {
        // Try navigator.storage
        if (navigator.storage && navigator.storage.estimate) {
            try {
                const estimate = await navigator.storage.estimate();
                if (estimate.quota && estimate.usage !== undefined) {
                    return estimate.quota - estimate.usage;
                }
            } catch (e) {
                console.error("Storage estimate failed", e);
            }
        }

        // Fallback default 10GB
        return 10 * 1024 * 1024 * 1024;
    }

    async updateDeviceStatus() {
        if (!this.deviceId) await this.loadDeviceId();

        const freeSpace = await this.getFreeSpace();
        const status: DeviceStatus = {
            id: this.deviceId,
            name: this.deviceName,
            freeSpace: freeSpace,
            timestamp: Date.now()
        };

        // Determine folder path
        const watchedFolder = this.data.settings.watchedFolder;
        if (!watchedFolder) return;

        const devicesDir = watchedFolder + "/.cross-player-devices";

        try {
            if (!(await this.app.vault.adapter.exists(devicesDir))) {
                await this.app.vault.createFolder(devicesDir);
            }

            const filePath = `${devicesDir}/${this.deviceId}.json`;
            await this.app.vault.adapter.write(filePath, JSON.stringify(status, null, 2));

            // Also calculate limit now
            await this.calculateDynamicLimit();

        } catch (e) {
            console.error("Failed to update device status", e);
        }
    }

    async calculateDynamicLimit() {
        // Use manual setting
        const limitGB = this.data.settings.storageLimitGB || 10;
        this.dynamicStorageLimit = limitGB * 1024 * 1024 * 1024;
        this.limitingDevice = "Manual Setting";

        // Update stats in queue view
        if (this.listView) this.listView.refresh();
    }

    async loadData() {
        const loaded = await super.loadData() as Partial<CrossPlayerData> | null;

        // Ensure settings are merged with defaults
        const settings: CrossPlayerSettings = Object.assign({}, DEFAULT_SETTINGS, loaded?.settings ?? {});

        // Recover from partial sync / overwritten data.json by restoring the last valid
        // per-device watched folder when synced settings arrive blank.
        if (!settings.watchedFolder) {
            const backupWatchedFolder = this.getLastGoodWatchedFolder();
            if (backupWatchedFolder) {
                settings.watchedFolder = backupWatchedFolder;
            }
        }

        this.data = Object.assign({
            settings: settings,
            queue: [],
            // Initialize playbackSpeed with default if not present
            playbackSpeed: settings.defaultPlaybackSpeed,
            consumptionStats: {}
        }, loaded) as CrossPlayerData;

        // Ensure settings are definitely correct in data object
        this.data.settings = settings;
        this.data.consumptionStats = this.data.consumptionStats || {};
        if (settings.watchedFolder) {
            this.setLastGoodWatchedFolder(settings.watchedFolder);
        }

        // Force playbackSpeed to respect default if it's the old default (1.0) and new default is different (2.0)
        // Or if it was never set (which the above assignment handles for new users).
        // But for existing users, loaded.playbackSpeed might be 1.0.
        // The user asked to "set the default speed to 2x". 
        // If I just rely on DEFAULT_SETTINGS, existing users won't see a change if they have saved data.
        // I will trust that `loaded.playbackSpeed` is what the user *last used*.
        // If it's missing, it defaults to settings.defaultPlaybackSpeed.
        await this.refreshTrackedDataFileState();
    }

    getTodayStatKey(): string {
        return new Date().toISOString().slice(0, 10);
    }

    recordConsumption(item: MediaItem) {
        if (item.countedAsConsumed) return;

        const day = this.getTodayStatKey();
        const bucket: ConsumptionStatBucket = this.data.consumptionStats?.[day] || {
            seconds: 0,
            completedCount: 0
        };

        bucket.seconds += Math.max(0, Math.round(item.duration || 0));
        bucket.completedCount += 1;

        this.data.consumptionStats = this.data.consumptionStats || {};
        this.data.consumptionStats[day] = bucket;
        item.countedAsConsumed = true;
        item.consumedAt = day;
    }

    revertConsumption(item: MediaItem) {
        if (!item.countedAsConsumed || !item.consumedAt || !this.data.consumptionStats) return;

        const bucket = this.data.consumptionStats[item.consumedAt];
        if (bucket) {
            bucket.seconds = Math.max(0, bucket.seconds - Math.max(0, Math.round(item.duration || 0)));
            bucket.completedCount = Math.max(0, bucket.completedCount - 1);

            if (bucket.seconds === 0 && bucket.completedCount === 0) {
                delete this.data.consumptionStats[item.consumedAt];
            } else {
                this.data.consumptionStats[item.consumedAt] = bucket;
            }
        }

        item.countedAsConsumed = false;
        delete item.consumedAt;
    }

    getConsumptionSummary(days?: number) {
        const stats = this.data.consumptionStats || {};
        const keys = Object.keys(stats).sort();
        const now = new Date();

        let seconds = 0;
        let completedCount = 0;
        let activeDays = 0;

        for (const key of keys) {
            const bucket = stats[key];
            if (!bucket) continue;

            if (typeof days === 'number') {
                const diff = now.getTime() - new Date(`${key}T00:00:00`).getTime();
                const diffDays = Math.floor(diff / 86400000);
                if (diffDays < 0 || diffDays >= days) continue;
            }

            seconds += bucket.seconds || 0;
            completedCount += bucket.completedCount || 0;
            if ((bucket.seconds || 0) > 0 || (bucket.completedCount || 0) > 0) {
                activeDays += 1;
            }
        }

        return { seconds, completedCount, activeDays, trackedDays: keys.length };
    }

    async saveData(refresh: boolean = true) {
        this.rememberQueueScrollPosition();

        const runSave = async (): Promise<void> => {
            await this.mergeFresherPlaybackStateFromDisk();
            await super.saveData(this.data);
            await this.refreshTrackedDataFileState();
            this.pendingPlaybackStateKeys.clear();
            if (refresh && this.listView) this.listView.refresh();
        };

        const queuedSave = this.saveDataChain.catch(() => undefined).then(runSave);
        this.saveDataChain = queuedSave.catch(() => undefined);
        await queuedSave;
    }

    registerWatchers() {
        // Register event
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                void this.handleFileChange(file);
                // Update device status if file added
                this.debouncedUpdateDeviceStatus();
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                // Handle rename/move
                void this.handleRename(file, oldPath);
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                void this.handleDelete(file);
                // Update device status if file deleted
                this.debouncedUpdateDeviceStatus();
            })
        );

        // Also watch for modifications to sync files from other devices
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                const watchedFolder = this.data.settings.watchedFolder;
                if (watchedFolder && file.path.startsWith(watchedFolder + "/.cross-player-devices/")) {
                    // Another device updated its status
                    void this.calculateDynamicLimit();
                }
            })
        );
    }

    async setWatchedFolder(path: string) {
        const normalizedPath = path.trim();
        const folder = this.app.vault.getAbstractFileByPath(normalizedPath);

        if (!(folder instanceof TFolder)) {
            new Notice(`Folder not found: ${normalizedPath}`);
            return;
        }

        this.data.settings.watchedFolder = normalizedPath;
        this.setLastGoodWatchedFolder(normalizedPath);

        // Remove stale queue items that were added while watching a different folder.
        this.data.queue = this.data.queue.filter(item => this.isPathInsideWatchedFolder(item.path, normalizedPath));

        if (this.mainView?.currentItem && !this.isPathInsideWatchedFolder(this.mainView.currentItem.path, normalizedPath)) {
            this.mainView.clearCurrentMedia();
        }

        try {
            await this.saveData();
            new Notice(`Watched folder set to: ${normalizedPath}`);

            // Just scan new folder.
            void this.scanFolder(normalizedPath);
        } catch (error) {
            console.error('[Cross Player] Failed to save watched folder', error);
            new Notice('Failed to save watched folder. Check disk space and sync state.');
        }
    }

    async scanFolder(folderPath: string) {
        const folder = this.app.vault.getAbstractFileByPath(folderPath === "" ? "/" : folderPath);
        if (folder instanceof TFolder) {
            const filesInFolder = this.collectMediaFiles(folder);

            // Process all files without saving individually.
            const promises = filesInFolder.map(file => this.handleFileChange(file, false));
            const changedItems = await Promise.all(promises);

            // Save once at the end, and only when the scan actually changed queue data.
            if (changedItems.some(Boolean)) {
                await this.saveData();
            }
        } else {
            console.warn("Watched path is not a folder:", folderPath);
        }
    }

    async getMediaDuration(file: TFile): Promise<number> {
        return new Promise((resolve) => {
            const video = activeDocument.createElement('video');
            video.preload = 'metadata';
            video.onloadedmetadata = () => {
                resolve(video.duration);
                video.remove();
            };
            video.onerror = () => {
                resolve(0);
                video.remove();
            };
            video.src = this.app.vault.getResourcePath(file);
        });
    }

    isAndroidPlaybackProbeSensitive(): boolean {
        if (!Platform.isMobile) return false;
        return Platform.isAndroidApp;
    }

    shouldDeferMetadataProbe(): boolean {
        return this.isAndroidPlaybackProbeSensitive() && !!this.mainView?.isActivelyPlayingLocally();
    }

    queueDeferredMetadataHydration(path: string) {
        this.deferredMetadataPaths.add(path);
        this.scheduleDeferredMetadataHydration();
    }

    scheduleDeferredMetadataHydration(delay: number = 2000) {
        if (this.deferredMetadataTimer !== null) return;

        this.deferredMetadataTimer = window.setTimeout(() => {
            this.deferredMetadataTimer = null;
            void this.flushDeferredMetadataHydration();
        }, delay);
    }

    async flushDeferredMetadataHydration() {
        if (this.isHydratingDeferredMetadata) return;
        if (this.shouldDeferMetadataProbe()) {
            this.scheduleDeferredMetadataHydration(3000);
            return;
        }

        this.isHydratingDeferredMetadata = true;
        try {
            while (this.deferredMetadataPaths.size > 0) {
                if (this.shouldDeferMetadataProbe()) {
                    this.scheduleDeferredMetadataHydration(3000);
                    break;
                }

                const nextPath = this.deferredMetadataPaths.values().next().value as string | undefined;
                if (!nextPath) break;

                this.deferredMetadataPaths.delete(nextPath);

                const file = this.app.vault.getAbstractFileByPath(nextPath);
                if (!(file instanceof TFile)) continue;

                const queueItem = this.data.queue.find(item => item.path === nextPath);
                if (!queueItem || queueItem.duration > 0) continue;

                const duration = await this.getMediaDuration(file);
                if (duration <= 0) continue;

                const latestItem = this.data.queue.find(item => item.path === nextPath);
                if (!latestItem || latestItem.duration > 0) continue;

                latestItem.duration = duration;
                latestItem.size = latestItem.size || file.stat.size;
                await this.saveData(false);

                if (this.listView) {
                    this.listView.updateStats();
                }
            }
        } finally {
            this.isHydratingDeferredMetadata = false;

            if (this.deferredMetadataPaths.size > 0) {
                this.scheduleDeferredMetadataHydration(3000);
            }
        }
    }

    getQueueStats() {
        let totalDuration = 0;
        let totalSize = 0;

        for (const item of this.data.queue) {
            // Try to get size from vault file (most accurate)
            const file = this.app.vault.getAbstractFileByPath(item.path);
            if (file instanceof TFile) {
                totalSize += file.stat.size;
            } else if (item.size) {
                // Fallback to stored size
                totalSize += item.size;
            }

            // Only count remaining duration for pending/playing items? 
            // User said "estimated time to complete all media in the queue".
            // Usually means remaining time.
            // If item is 'completed', should we count it? 
            // "complete all media in the queue" implies remaining.
            // But let's assume all items in queue are "to be watched" or "being watched".
            // If status is 'completed', user usually removes it or we clean it.
            // If it's still in queue, maybe we should count it? 
            // Let's count only 'pending' and 'playing'.

            if (item.status === 'pending' || item.status === 'playing') {
                // Subtract current position (if any) for both playing and pending items
                // This allows ETC to account for partially watched items in the queue
                const position = item.position || 0;
                totalDuration += Math.max(0, item.duration - position);
            }
        }

        return { totalDuration, totalSize };
    }

    formatDuration(seconds: number): string {
        if (!seconds || isNaN(seconds)) return "0s";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}h ${m}m ${s}s`;
        return `${m}m ${s}s`;
    }

    async handleRename(file: TAbstractFile, oldPath: string) {
        // 1. If file was in queue (by oldPath), update its path
        // We need to check if oldPath was in queue. 
        // But wait, if it's a folder rename, oldPath is the folder path.

        // Find items in queue that start with oldPath
        // Case 1: Exact match (file rename)
        // Case 2: Prefix match (folder rename)

        const queue = this.data.queue;

        const itemsToUpdate = queue.filter((item: MediaItem) => item.path === oldPath || item.path.startsWith(oldPath + "/"));

        if (itemsToUpdate.length > 0) {
            for (const item of itemsToUpdate) {
                // Calculate new path
                // If oldPath = "A/Old.mp4", newPath = "A/New.mp4" (file.path)
                // If oldPath = "A/OldFolder", newPath = "A/NewFolder" (file.path)
                // item.path = "A/OldFolder/File.mp4"
                // new item path = "A/NewFolder/File.mp4"

                const newPath = item.path.replace(oldPath, file.path);
                item.path = newPath;

                // Check if new path is still inside watched folder
                const watchedFolder = this.data.settings.watchedFolder;
                if (watchedFolder && !this.isPathInsideWatchedFolder(newPath, watchedFolder)) {
                    // Moved OUT of watched folder -> Delete
                    item.status = 'completed'; // Mark for cleanup or delete immediately
                    // Let's delete immediately from queue to be clean
                    // We can't mutate array while iterating easily if we filter. 
                    // But we are iterating a filtered list.
                    // Better to just mark them or filter queue later.
                }
            }

            // Remove items that moved out
            const watchedFolder = this.data.settings.watchedFolder;
            if (watchedFolder) {
                const initialLength = this.data.queue.length;
                this.data.queue = this.data.queue.filter(item => this.isPathInsideWatchedFolder(item.path, watchedFolder));
                if (this.data.queue.length !== initialLength) {
                    this.markQueueChanged();
                }
            }

            await this.saveData();
        }

        // 2. Check if the new location is inside watched folder (Move In)
        // Even if we updated paths, we might have moved a NEW folder IN.
        // If we just renamed inside, handleFileChange will check if it's already in queue.
        void this.handleFileChange(file);
    }

    async handleDelete(file: TAbstractFile) {
        // If file or folder deleted, remove from queue
        const path = file.path;

        // Stop playback if current item is deleted
        if (this.mainView && this.mainView.currentItem) {
            // Check if deleted file is the current item
            // OR if deleted file is a folder containing the current item
            if (this.mainView.currentItem.path === path || this.mainView.currentItem.path.startsWith(path + "/")) {
                this.mainView.clearCurrentMedia();
                new Notice("Playing media was deleted.");
            }
        }

        const initialLength = this.data.queue.length;
        this.data.queue = this.data.queue.filter(item => item.path !== path && !item.path.startsWith(path + "/"));

        if (this.data.queue.length !== initialLength) {
            this.markQueueChanged();
            await this.saveData();
        }
    }

    async handleFileChange(file: TAbstractFile, shouldSave: boolean = true): Promise<boolean> {
        const folderPath = this.data.settings.watchedFolder ?? "";
        // If it's undefined somehow, return, but allow "" for root
        if (this.data.settings.watchedFolder === undefined) return false;

        // Ignore hidden files and folders (starting with .)
        if (file.name.startsWith('.') || file.path.includes('/.')) return false;

        // Recursively handle folders
        if (file instanceof TFolder) {
            let changed = false;
            for (const child of file.children) {
                changed = (await this.handleFileChange(child, shouldSave)) || changed;
            }
            return changed;
        }

        if (!(file instanceof TFile)) return false;

        // Double check it is in the folder
        if (!this.isPathInsideWatchedFolder(file.path, folderPath)) return false;

        console.log(`[Cross Player] processing: ${file.path}`);

        const ext = file.extension.toLowerCase();
        if (!SUPPORTED_MEDIA_EXTENSIONS.includes(ext)) return false;

        // Check if already in queue
        let existing = this.data.queue.find(item => item.path === file.path);
        if (!existing) {
            const deferDurationProbe = this.shouldDeferMetadataProbe();
            const duration = deferDurationProbe ? 0 : await this.getMediaDuration(file);

            // Double check existence after async duration fetch to prevent race conditions
            existing = this.data.queue.find(item => item.path === file.path);
            if (existing) {
                // If it appeared while we were waiting, verify its props
                if (!existing.duration && duration > 0) {
                    existing.duration = duration;
                    if (shouldSave) await this.saveData();
                    return true;
                }
                return false;
            }

            const newItem: MediaItem = {
                id: Math.random().toString(36).substring(2, 11),
                path: file.path, // Store vault relative path
                name: file.name,
                status: 'pending',
                position: 0,
                duration: duration,
                size: file.stat.size
            };
            this.data.queue.push(newItem);
            if (deferDurationProbe) {
                this.queueDeferredMetadataHydration(file.path);
            }
            this.markQueueChanged();
            if (shouldSave) {
                await this.saveData();
                new Notice(`Added ${file.name} to queue`);
            }
            return true;
        } else {
            // Update duration/size if missing (migration)
            let changed = false;
            if (!existing.duration) {
                if (this.shouldDeferMetadataProbe()) {
                    this.queueDeferredMetadataHydration(file.path);
                } else {
                    const duration = await this.getMediaDuration(file);
                    if (duration > 0) {
                        existing.duration = duration;
                        changed = true;
                    }
                }
            }
            if (!existing.size) {
                existing.size = file.stat.size;
                changed = true;
            }
            if (changed && shouldSave) await this.saveData();
            return changed;
        }
    }

    async activateListView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_CROSS_PLAYER_LIST);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getLeftLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE_CROSS_PLAYER_LIST, active: true });
        }
        this.listView = leaf.view instanceof CrossPlayerListView ? leaf.view : null;
        await workspace.revealLeaf(leaf);
    }

    async activateMainView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_CROSS_PLAYER_MAIN);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            // Center leaf
            leaf = workspace.getLeaf(false);
            await leaf.setViewState({ type: VIEW_TYPE_CROSS_PLAYER_MAIN, active: true });
        }
        await workspace.revealLeaf(leaf);
        workspace.setActiveLeaf(leaf, { focus: true });

        // Ensure we get the view instance
        if (leaf.view instanceof CrossPlayerMainView) {
            this.mainView = leaf.view;
            // Force focus on the container element
            // We need a slight delay to ensure the view is fully active and DOM is ready
            window.setTimeout(() => {
                if (this.mainView) {
                    this.mainView.contentEl.focus();
                    if (this.mainView.videoEl) {
                        this.mainView.videoEl.focus();
                    }
                }
            }, 100);
        }
    }

    async playMedia(item: MediaItem, autoPlay: boolean = false) {
        this.rememberQueueScrollPosition();

        // 1. Prepare Main View and stop any current playback immediately
        await this.activateMainView();
        if (this.mainView) {
            await this.mainView.stop();
        }

        // 2. Update status of previous item if playing
        const currentPlaying = this.data.queue.find(i => i.status === 'playing');
        if (currentPlaying && currentPlaying.id !== item.id) {
            if (currentPlaying.finished) {
                currentPlaying.status = 'completed';
            } else {
                currentPlaying.status = 'pending';
            }
            this.markPlaybackStateChanged(currentPlaying);
        }

        if (item.status === 'completed') {
            item.finished = true;
        }

        item.status = 'playing';
        this.markPlaybackStateChanged(item);
        await this.saveData();

        // 3. Start new playback
        if (this.mainView) {
            const success = await this.mainView.play(item, autoPlay);
            if (!success) {
                // Revert status if playback failed
                item.status = 'pending';
                this.markPlaybackStateChanged(item);
                await this.saveData();
                new Notice(`Failed to play ${item.name}`);
            }
        }
    }

    async playNextUnread() {
        this.rememberQueueScrollPosition();

        // Find the index of the last played item (which might be completed now)
        let currentIndex = -1;
        if (this.mainView && this.mainView.currentItem) {
            currentIndex = this.data.queue.findIndex(i => i.id === this.mainView.currentItem?.id);
        }

        // If not found, fallback to searching from beginning
        if (currentIndex === -1) {
            // Try to find any playing item
            currentIndex = this.data.queue.findIndex(i => i.status === 'playing');
        }

        // Find next pending after currentIndex
        const nextItem = this.data.queue.find((item, index) => index > currentIndex && item.status === 'pending');

        if (nextItem) {
            await this.playMedia(nextItem, true);
        }
    }

    private async permanentlyDeleteVaultFile(file: TAbstractFile) {
        await this.app.fileManager.trashFile(file);
    }

    async playNextItem() {
        this.rememberQueueScrollPosition();

        let currentIndex = -1;
        if (this.mainView && this.mainView.currentItem) {
            currentIndex = this.data.queue.findIndex(i => i.id === this.mainView.currentItem?.id);
        }

        const nextIndex = currentIndex + 1;
        if (nextIndex < this.data.queue.length) {
            await this.playMedia(this.data.queue[nextIndex], true);
        }
    }

    async playPreviousItem() {
        this.rememberQueueScrollPosition();

        let currentIndex = -1;
        if (this.mainView && this.mainView.currentItem) {
            currentIndex = this.data.queue.findIndex(i => i.id === this.mainView.currentItem?.id);
        }

        if (currentIndex === -1) return;

        const prevIndex = currentIndex - 1;
        if (prevIndex >= 0) {
            await this.playMedia(this.data.queue[prevIndex], true);
        }
    }

    async updateStatus(id: string, status: 'pending' | 'playing' | 'completed') {
        const item = this.data.queue.find(i => i.id === id);
        if (item && item.status !== status) {
            const previousStatus = item.status;
            item.status = status;
            if (status === 'completed') {
                item.finished = true;
                this.recordConsumption(item);
            } else if (previousStatus === 'completed') {
                // Keep historical stats unless the user explicitly marks it unread.
            }
            this.markPlaybackStateChanged(item);
            await this.saveData();
        }
    }

    async updatePosition(id: string, position: number, force: boolean = false) {
        const item = this.data.queue.find(i => i.id === id);
        if (item && (force || Math.abs(item.position - position) > 1)) {
            item.position = position;
            this.markPlaybackStateChanged(item);
            await this.saveData(false);
        }
    }

    async moveItem(index: number, direction: number) {
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= this.data.queue.length) return;

        const item = this.data.queue[index];
        this.data.queue.splice(index, 1);
        this.data.queue.splice(newIndex, 0, item);
        this.markQueueChanged();
        await this.saveData();
    }

    async reorderItem(oldIndex: number, newIndex: number) {
        if (oldIndex < 0 || oldIndex >= this.data.queue.length || newIndex < 0 || newIndex >= this.data.queue.length) return;
        const item = this.data.queue[oldIndex];
        this.data.queue.splice(oldIndex, 1);
        this.data.queue.splice(newIndex, 0, item);
        this.markQueueChanged();
        await this.saveData();
    }

    async sortQueue(by: 'name' | 'type' | 'size', order: 'asc' | 'desc') {
        this.data.queue.sort((a, b) => {
            let valA: string | number = a.name.toLowerCase();
            let valB: string | number = b.name.toLowerCase();

            if (by === 'type') {
                valA = a.path.split('.').pop()?.toLowerCase() || '';
                valB = b.path.split('.').pop()?.toLowerCase() || '';
            } else if (by === 'size') {
                valA = a.size || 0;
                valB = b.size || 0;
            }

            if (valA < valB) return order === 'asc' ? -1 : 1;
            if (valA > valB) return order === 'asc' ? 1 : -1;
            return 0;
        });
        this.markQueueChanged();
        await this.saveData();
    }

    async cleanConsumedMedia() {
        this.rememberQueueScrollPosition();

        const toRemove = this.data.queue.filter(item => item.status === 'completed');
        if (toRemove.length === 0) {
            new Notice("No completed media to clean.");
            return;
        }

        const removedIds = new Set<string>();
        let count = 0;
        let failedCount = 0;
        for (const item of toRemove) {
            try {
                if (this.mainView?.currentItem?.id === item.id) {
                    this.mainView.clearCurrentMedia();
                }

                const file = this.app.vault.getAbstractFileByPath(item.path);
                if (file instanceof TFile) {
                    await this.permanentlyDeleteVaultFile(file);
                    count++;
                    removedIds.add(item.id);
                } else if (!file) {
                    removedIds.add(item.id);
                }
            } catch (e) {
                console.error("Failed to delete", item.path, e);
                failedCount++;
            }
        }

        this.data.queue = this.data.queue.filter(item => item.status !== 'completed' || !removedIds.has(item.id));
        this.markQueueChanged();
        await this.saveData();
        if (failedCount > 0) {
            new Notice(`Permanently deleted ${count} media file(s). ${failedCount} item(s) stayed in the queue because deletion failed.`);
            return;
        }
        new Notice(`Permanently deleted ${count} media file(s).`);
    }

    async deleteMediaItem(item: MediaItem) {
        this.rememberQueueScrollPosition();

        // If it's the current playing item, stop playback
        const isCurrent = this.mainView && this.mainView.currentItem && this.mainView.currentItem.id === item.id;

        // Find next item before mutating queue or clearing current playback.
        let nextItem: MediaItem | undefined;
        if (isCurrent) {
            const currentIndex = this.data.queue.findIndex(i => i.id === item.id);
            nextItem = this.data.queue.find((i, index) => index > currentIndex && i.status === 'pending');
            this.mainView?.clearCurrentMedia();
        }

        // Delete from vault
        let deletedFromDisk = false;
        try {
            const file = this.app.vault.getAbstractFileByPath(item.path);
            if (file instanceof TFile) {
                await this.permanentlyDeleteVaultFile(file);
                deletedFromDisk = true;
            } else if (!file) {
                deletedFromDisk = true;
            }
        } catch (e) {
            console.error("Error deleting file:", e);
        }

        if (!deletedFromDisk) {
            new Notice("Could not permanently delete the file. It was left in the queue.");
            return;
        }

        // Remove from queue
        this.data.queue = this.data.queue.filter(i => i.id !== item.id);
        this.markQueueChanged();
        await this.saveData();
        new Notice(`Permanently deleted: ${item.name}`);

        if (isCurrent) {
            if (nextItem) {
                await this.playMedia(nextItem, true);
            } else {
                void this.activateListView();
            }
        }
    }

    async deleteCurrentFile() {
        if (!this.mainView || !this.mainView.currentItem) {
            new Notice("No active media to delete.");
            return;
        }
        await this.deleteMediaItem(this.mainView.currentItem);
    }

    async setMediaItemAsUnread(item: MediaItem) {
        this.rememberQueueScrollPosition();

        // Find the actual item in the queue to ensure we are modifying the source of truth
        // This prevents issues where 'item' might be a stale reference (e.g. from mainView.currentItem)
        const queueItem = this.data.queue.find(i => i.id === item.id);

        if (!queueItem) {
            new Notice("Item not found in queue.");
            return;
        }

        const isCurrent = this.mainView && this.mainView.currentItem && this.mainView.currentItem.id === item.id;

        if (isCurrent && this.mainView) {
            // Stop playback without re-persisting the item we're resetting.
            this.mainView.clearCurrentMedia();
            void this.activateListView();
        }

        // Update state on the queue item
        this.revertConsumption(queueItem);
        queueItem.status = 'pending';
        queueItem.finished = false;
        queueItem.position = 0;
        this.markPlaybackStateChanged(queueItem);
        await this.saveData();

        // Always refresh list view to update visual progress and status icon
        if (this.listView) {
            this.listView.refresh();
        }

        new Notice(`Marked as unread: ${queueItem.name}`);
    }

    async setCurrentAsUnread() {
        if (!this.mainView || !this.mainView.currentItem) {
            new Notice("No active media.");
            return;
        }
        await this.setMediaItemAsUnread(this.mainView.currentItem);
    }

    async downloadVideos(links: string[], quality: string, type: 'video' | 'audio') {
        if (!Platform.isDesktop) {
            new Notice("Downloading is only supported on Desktop.");
            return;
        }
        const { downloadFolder, watchedFolder } = this.data.settings;
        const targetFolder = downloadFolder || watchedFolder;

        if (!targetFolder) {
            new Notice("Please set a download folder or watched folder first.");
            return;
        }

        // Resolve absolute path for the target folder
        const absolutePath = this.buildAbsoluteVaultPath(targetFolder);
        if (!absolutePath) {
            new Notice("Could not resolve absolute path for vault.");
            return;
        }

        if (!(await this.app.vault.adapter.exists(targetFolder))) {
            new Notice(`Target folder does not exist: ${targetFolder}`);
            return;
        }

        new Notice(`Starting download of ${links.length} items...`);

        for (const link of links) {
            if (!link.trim()) continue;
            void this.startDownload(link.trim(), quality, type, absolutePath);
        }
    }

    async startDownload(link: string, quality: string, type: 'video' | 'audio', cwd: string, existingId?: string) {
        if (!Platform.isDesktop) return;

        const { youtubeDlpPath, ffmpegPath, jsRuntimePath } = this.data.settings;
        const ytPath = youtubeDlpPath.trim();

        const downloadId = existingId || Math.random().toString(36).substring(7);

        let downloadStatus: ActiveDownload;

        if (existingId) {
            // Resume
            const existing = this.activeDownloads.find(d => d.id === existingId);
            if (existing) {
                downloadStatus = existing;
                downloadStatus.status = 'downloading';
                downloadStatus.error = undefined;
            } else {
                // Should not happen usually
                return;
            }
        } else {
            downloadStatus = {
                id: downloadId,
                name: link,
                progress: '0%',
                speed: '0',
                eta: '?',
                status: 'downloading',
                params: { url: link, quality, type }
            };
            this.activeDownloads.push(downloadStatus);
        }

        this.listView?.updateDownloadProgress();

        const args = [
            link,
            '-o', '%(title)s.%(ext)s',
            '--no-playlist',
            '--newline',
            '--restrict-filenames',
            '--no-mtime',
            '--extractor-args', 'youtube:player_client=android_vr',
            '--js-runtimes', jsRuntimePath ? `node:${jsRuntimePath}` : 'node',
            '--format-sort', 'ext:mp4:m4a'
        ];

        if (ffmpegPath) {
            args.push('--ffmpeg-location', ffmpegPath);
        }

        if (type === 'audio') {
            args.push('-x', '--audio-format', 'mp3');
        } else {
            if (quality === 'best') {
                args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best');
            } else if (quality === '1080p') {
                args.push('-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best');
            } else if (quality === '720p') {
                args.push('-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best');
            } else if (quality === '480p') {
                args.push('-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best');
            }
            args.push('--merge-output-format', 'mp4');
        }

        try {
            const spawn = this.getSpawnFunction();
            if (!spawn) {
                new Notice('Desktop process access is unavailable in this build.');
                downloadStatus.status = 'error';
                downloadStatus.error = 'Desktop process access unavailable';
                this.listView?.updateDownloadProgress();
                return;
            }
            console.log(`[Cross Player] Spawning in ${cwd}: ${ytPath} ${args.join(' ')}`);

            // Fix PATH for macOS GUI
            const env = { ...process.env };
            if (Platform.isDesktop && process.platform === 'darwin') {
                const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
                env.PATH = extraPaths.join(':') + (env.PATH ? ':' + env.PATH : '');
            }

            const child = spawn(ytPath, args, { cwd: cwd, env });
            downloadStatus.childProcess = child;

            child.stdout?.on('data', (data: Uint8Array | string) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const trimmedLine = line.trim();

                    // The first line might be the title due to --get-title
                    if (trimmedLine && !trimmedLine.startsWith('[') && downloadStatus.name === link) {
                        downloadStatus.name = trimmedLine;
                        this.listView?.updateDownloadProgress();
                    }

                    if (line.includes('[download]')) {
                        const percentMatch = line.match(/(\d+\.\d+)%/);
                        const speedMatch = line.match(/at\s+([^\s]+)/);
                        const etaMatch = line.match(/ETA\s+([^\s]+)/);

                        if (percentMatch) {
                            let percent = parseFloat(percentMatch[1]);
                            // If audio/converting expected, scale download progress to 90% max
                            if (type === 'audio') {
                                percent = percent * 0.9;
                            }
                            downloadStatus.progress = percent.toFixed(1) + '%';
                        }
                        if (speedMatch) {
                            downloadStatus.speed = speedMatch[1];
                        }
                        if (etaMatch) {
                            downloadStatus.eta = etaMatch[1];
                        }
                        this.listView?.updateDownloadProgress();
                    }
                    if (line.includes('[youtube]')) {
                        // Extract title from youtube metadata line: [youtube] <id>: Downloading webpage
                        // We need another way to get the title quickly.
                        // Actually, yt-dlp prints the title if we use --print title.
                        // But let's look for info logs.
                    }
                    if (line.includes('[info]')) {
                        const titleMatch = line.match(/\[info\]\s+(.*?):\s+Downloading/);
                        if (titleMatch && titleMatch[1]) {
                            downloadStatus.name = titleMatch[1];
                        }
                    }
                    if (line.includes('[download] Destination:')) {
                        const name = line.split('Destination:')[1].trim();
                        // Only update if it's not a generic name
                        if (name) {
                            // Remove extension if possible
                            const nameWithoutExt = name.replace(/\.[^/.]+$/, "");
                            downloadStatus.name = nameWithoutExt;
                        }
                        this.listView?.updateDownloadProgress();
                    }
                    // Conversion / Post-processing detection
                    if (line.includes('[ExtractAudio]') || line.includes('[ffmpeg]') || line.includes('[Merger]')) {
                        downloadStatus.status = 'converting';
                        downloadStatus.progress = '95%'; // Jump to 95% during conversion

                        const destMatch = line.match(/(?:into|to)\s+"(.*)"/);
                        if (destMatch && destMatch[1]) {
                            const nameWithoutExt = destMatch[1].replace(/\.[^/.]+$/, "");
                            downloadStatus.name = nameWithoutExt;
                        }

                        this.listView?.updateDownloadProgress();
                    }
                }
            });

            child.stderr?.on('data', (data: Uint8Array | string) => {
                const errorMsg = data.toString();
                console.error(`yt-dlp stderr: ${errorMsg}`);

                // Detect specific errors
                if (errorMsg.includes("HTTP Error 400") || errorMsg.includes("Precondition check failed") || errorMsg.includes("Unable to extract")) {
                    downloadStatus.error = "Update yt-dlp!";
                    downloadStatus.status = 'error';
                    this.listView?.updateDownloadProgress();
                } else if (errorMsg.includes("ffmpeg-location") && errorMsg.includes("does not exist")) {
                    // This is a warning, but good to know
                    console.warn("FFmpeg path invalid");
                }
            });

            child.on('error', (err: Error) => {
                console.error("Failed to start process", err);
                downloadStatus.status = 'error';
                downloadStatus.error = err.message;
                this.listView?.updateDownloadProgress();
            });

            child.on('close', (code: number | null) => {
                // If code is null/signal, it might be killed manually
                if (code === 0) {
                    downloadStatus.status = 'completed';
                    downloadStatus.progress = '100%';
                    console.log(`Download completed for: ${downloadStatus.name}`);

                    // Refresh watched folder after a slight delay to let Obsidian see the file
                    const { watchedFolder } = this.data.settings;
                    if (watchedFolder) {
                        window.setTimeout(() => {
                            void this.scanFolder(watchedFolder);
                        }, 2000);
                    }
                } else if (downloadStatus.status !== 'paused' && code !== null) {
                    // Only mark error if not paused and not manually killed (though killed usually gives null code or signal)
                    // If we killed it for pause, we set status to 'paused' BEFORE calling kill, so we check that.
                    downloadStatus.status = 'error';
                    downloadStatus.error = `Exit code ${code}`;
                }

                downloadStatus.childProcess = undefined;
                this.listView?.updateDownloadProgress();

                if (downloadStatus.status === 'completed') {
                    window.setTimeout(() => {
                        this.activeDownloads = this.activeDownloads.filter(d => d.id !== downloadId);
                        this.listView?.updateDownloadProgress();
                    }, 5000);
                }
            });

        } catch (error) {
            console.error("Download failed", error);
            new Notice(`Failed to download: ${link}`);
            downloadStatus.status = 'error';
            downloadStatus.error = 'Failed to start';
            this.listView?.updateDownloadProgress();
        }
    }

    cancelDownload(id: string) {
        const dl = this.activeDownloads.find(d => d.id === id);
        if (dl) {
            if (dl.childProcess) {
                dl.childProcess.kill();
            }
            this.activeDownloads = this.activeDownloads.filter(d => d.id !== id);
            this.listView?.updateDownloadProgress();
            new Notice("Download cancelled");
        }
    }

    pauseDownload(id: string) {
        const dl = this.activeDownloads.find(d => d.id === id);
        if (dl && dl.childProcess) {
            dl.status = 'paused';
            dl.childProcess.kill(); // Kill process to stop download
            this.listView?.updateDownloadProgress();
        }
    }

    retryDownload(id: string) {
        const dl = this.activeDownloads.find(d => d.id === id);
        if (dl && dl.status === 'error') {
            const { url, quality, type } = dl.params;

            // Re-resolve cwd just in case, though we could store it in params too
            const { downloadFolder, watchedFolder } = this.data.settings;
            const targetFolder = downloadFolder || watchedFolder;

            const absolutePath = this.buildAbsoluteVaultPath(targetFolder);
            if (!absolutePath) {
                new Notice("Could not resolve absolute path for vault.");
                return;
            }

            void this.startDownload(url, quality, type, absolutePath, id);
        }
    }

    resumeDownload(id: string) {
        if (!Platform.isDesktop) return;

        const dl = this.activeDownloads.find(d => d.id === id);
        if (dl && dl.params) {
            const { downloadFolder, watchedFolder } = this.data.settings;
            const targetFolder = downloadFolder || watchedFolder;

            // Re-resolve path
            const absolutePath = this.buildAbsoluteVaultPath(targetFolder) ?? '';

            if (absolutePath) {
                void this.startDownload(dl.params.url, dl.params.quality, dl.params.type, absolutePath, id);
            }
        }
    }
}

class YouTubeDownloadModal extends Modal {
    plugin: CrossPlayerPlugin;
    videoLinks: string = '';
    audioLinks: string = '';
    quality: string;

    constructor(app: App, plugin: CrossPlayerPlugin) {
        super(app);
        this.plugin = plugin;
        this.quality = 'best';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Download from YouTube' });

        new Setting(contentEl)
            .setName('Video Links')
            .setDesc('Paste links to download as VIDEO (with audio), one per line.')
            .addTextArea(text => text
                .setPlaceholder('https://youtube.com/watch?v=...')
                .setValue(this.videoLinks)
                .onChange(async (value) => {
                    this.videoLinks = value;
                }));

        // Style the video textarea
        const textareas = contentEl.querySelectorAll('textarea');
        if (textareas.length > 0) {
            textareas[0].addClass('cross-player-download-textarea');
        }

        new Setting(contentEl)
            .setName('Audio Links')
            .setDesc('Paste links to download as AUDIO ONLY (mp3), one per line.')
            .addTextArea(text => text
                .setPlaceholder('https://youtube.com/watch?v=...')
                .setValue(this.audioLinks)
                .onChange(async (value) => {
                    this.audioLinks = value;
                }));

        // Style the audio textarea
        if (textareas.length > 1) { // It might not be created yet in DOM flow if I used querySelectorAll immediately after addTextArea.
            // Actually Setting.addTextArea creates it synchronously.
            // But let's be safe and query again or query specific one.
        }
        // Let's re-query to be safe and clear
        const allTextareas = contentEl.querySelectorAll('textarea');
        allTextareas.forEach(ta => {
            ta.addClass('cross-player-download-textarea');
        });

        new Setting(contentEl)
            .setName('Quality')
            .setDesc('Select max video quality (ignored for audio links).')
            .addDropdown(drop => drop
                .addOption('best', 'Best Available')
                .addOption('1080p', '1080p')
                .addOption('720p', '720p')
                .addOption('480p', '480p')
                .setValue(this.quality)
                .onChange(async (value) => {
                    this.quality = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Download All')
                .setCta()
                .onClick(() => {
                    const videoList = this.videoLinks.split('\n').filter(l => l.trim().length > 0);
                    const audioList = this.audioLinks.split('\n').filter(l => l.trim().length > 0);

                    if (videoList.length === 0 && audioList.length === 0) {
                        new Notice('Please enter at least one link.');
                        return;
                    }

                    if (videoList.length > 0) {
                        void this.plugin.downloadVideos(videoList, this.quality, 'video');
                    }

                    if (audioList.length > 0) {
                        void this.plugin.downloadVideos(audioList, this.quality, 'audio');
                    }

                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    plugin: CrossPlayerPlugin;

    constructor(app: App, plugin: CrossPlayerPlugin) {
        super(app);
        this.plugin = plugin;
    }

    getItems(): TFolder[] {
        return this.plugin.getVaultFolders();
    }

    getItemText(item: TFolder): string {
        return item.path;
    }

    onChooseItem(item: TFolder): void {
        void this.plugin.setWatchedFolder(item.path);
    }
}

class ConfirmCleanConsumedMediaModal extends Modal {
    plugin: CrossPlayerPlugin;

    constructor(app: App, plugin: CrossPlayerPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        const completedCount = this.plugin.data.queue.filter(item => item.status === 'completed').length;

        contentEl.empty();
        contentEl.createEl('h3', { text: 'Clean consumed media?' });
        contentEl.createEl('p', {
            text: completedCount > 0
                ? `This will permanently delete ${completedCount} completed media file(s) and remove them from the queue.`
                : 'There are no completed media files to clean right now.'
        });

        const actions = contentEl.createDiv({ cls: 'cross-player-modal-actions' });

        const cancelBtn = actions.createEl('button', { text: completedCount > 0 ? 'Cancel' : 'Close' });
        cancelBtn.onclick = () => this.close();

        if (completedCount > 0) {
            const confirmBtn = actions.createEl('button', { text: 'Clean Media', cls: 'mod-warning' });
            confirmBtn.onclick = async () => {
                this.close();
                await this.plugin.cleanConsumedMedia();
            };
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ConsumptionStatsModal extends Modal {
    plugin: CrossPlayerPlugin;

    constructor(app: App, plugin: CrossPlayerPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        const today = this.plugin.getConsumptionSummary(1);
        const week = this.plugin.getConsumptionSummary(7);
        const month = this.plugin.getConsumptionSummary(30);
        const allTime = this.plugin.getConsumptionSummary();

        contentEl.empty();
        contentEl.createEl('h3', { text: 'Consumption Statistics' });

        const summary = contentEl.createDiv({ cls: 'cross-player-consumption-summary' });
        const rows = [
            ['Today', today],
            ['Last 7 days', week],
            ['Last 30 days', month],
            ['All time', allTime]
        ] as const;

        rows.forEach(([label, data]) => {
            const row = summary.createDiv({ cls: 'cross-player-consumption-row' });
            row.createEl('strong', { text: label });
            row.createSpan({ text: `${this.plugin.formatDuration(data.seconds)} watched` });
            row.createSpan({ text: `${data.completedCount} item(s) completed` });
            if (label === 'All time') {
                row.createSpan({ text: `${data.trackedDays} tracked day(s)` });
            }
        });

        const hint = contentEl.createEl('p', {
            text: 'Stats are stored as small daily buckets, so they stay compact even over long periods.'
        });
        hint.addClass('cross-player-muted-text');

        const closeBtn = contentEl.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class CrossPlayerSettingTab extends PluginSettingTab {
    plugin: CrossPlayerPlugin;

    constructor(app: App, plugin: CrossPlayerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl).setName('Playback').setHeading();

        new Setting(containerEl)
            .setName('Watched Folder')
            .setDesc('Current watched folder path (relative to vault root).')
            .addText(text => text
                .setPlaceholder('No folder set')
                .setValue(this.plugin.data.settings.watchedFolder)
                .setDisabled(true))
            .addButton(button => button
                .setButtonText('Set Watched Folder')
                .onClick(() => {
                    new FolderSuggestModal(this.app, this.plugin).open();
                }));

        new Setting(containerEl)
            .setName('Default Playback Speed')
            .setDesc('The default speed when the player starts or resets.')
            .addSlider(slider => slider
                .setLimits(0.5, 5.0, 0.1)
                .setValue(this.plugin.data.settings.defaultPlaybackSpeed)
                .onChange(async (value) => {
                    this.plugin.data.settings.defaultPlaybackSpeed = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('Seek Forward Seconds')
            .setDesc('Number of seconds to seek forward.')
            .addText(text => text
                .setValue(String(this.plugin.data.settings.seekSecondsForward))
                .onChange(async (value) => {
                    const parsed = parseInt(value);
                    if (!isNaN(parsed) && parsed > 0) {
                        this.plugin.data.settings.seekSecondsForward = parsed;
                        await this.plugin.saveData();
                    }
                }));

        new Setting(containerEl)
            .setName('Seek Backward Seconds')
            .setDesc('Number of seconds to seek backward.')
            .addText(text => text
                .setValue(String(this.plugin.data.settings.seekSecondsBackward))
                .onChange(async (value) => {
                    const parsed = parseInt(value);
                    if (!isNaN(parsed) && parsed > 0) {
                        this.plugin.data.settings.seekSecondsBackward = parsed;
                        await this.plugin.saveData();
                    }
                }));

        new Setting(containerEl)
            .setName('Show Media Indicator')
            .setDesc('Show audio/video icon in the queue list.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.data.settings.showMediaIndicator)
                .onChange(async (value) => {
                    this.plugin.data.settings.showMediaIndicator = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('Show Progress Color in Queue')
            .setDesc('Color the queue items based on playback progress.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.data.settings.showProgressColor)
                .onChange(async (value) => {
                    this.plugin.data.settings.showProgressColor = value;
                    await this.plugin.saveData();
                    this.plugin.listView?.refresh();
                }));

        new Setting(containerEl)
            .setName('Autoplay Next Video')
            .setDesc('Automatically play the next video in the queue when the current one finishes.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.data.settings.autoplayNext)
                .onChange(async (value) => {
                    this.plugin.data.settings.autoplayNext = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('Pause on Mobile Tap')
            .setDesc('Pause the player when tapping the video on mobile. If disabled, tapping only shows controls.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.data.settings.pauseOnMobileTap)
                .onChange(async (value) => {
                    this.plugin.data.settings.pauseOnMobileTap = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('Wrap Queue Item Text')
            .setDesc('Show full queue item names on multiple lines instead of truncating them.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.data.settings.wrapQueueText)
                .onChange(async (value) => {
                    this.plugin.data.settings.wrapQueueText = value;
                    await this.plugin.saveData();
                    this.plugin.listView?.refresh();
                }));

        new Setting(containerEl).setName('Audio').setHeading();

        new Setting(containerEl)
            .setName('Volume Boost')
            .setDesc('Boost playback above 100% for quiet media. Higher values may cause distortion.')
            .addSlider(slider => slider
                .setLimits(100, 300, 10)
                .setValue(this.plugin.data.settings.volumeBoostPercent)
                .onChange(async (value) => {
                    this.plugin.data.settings.volumeBoostPercent = value;
                    await this.plugin.saveData(false);
                    this.plugin.mainView?.applyAudioSettings();
                }));

        new Setting(containerEl)
            .setName('Sound Normalization')
            .setDesc('Apply dynamic range compression to make low-volume media easier to hear.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.data.settings.soundNormalization)
                .onChange(async (value) => {
                    this.plugin.data.settings.soundNormalization = value;
                    await this.plugin.saveData(false);
                    this.plugin.mainView?.applyAudioSettings();
                }));

        new Setting(containerEl).setName('Consumption Statistics').setHeading();

        const allTime = this.plugin.getConsumptionSummary();
        new Setting(containerEl)
            .setName('Usage Summary')
            .setDesc(`${this.plugin.formatDuration(allTime.seconds)} watched across ${allTime.completedCount} completed item(s).`)
            .addButton(button => button
                .setButtonText('View Statistics')
                .onClick(() => {
                    new ConsumptionStatsModal(this.app, this.plugin).open();
                }));

        new Setting(containerEl).setName('Downloads & Storage').setHeading();

        new Setting(containerEl)
            .setName('yt-dlp Binary Path')
            .setDesc('Absolute path to yt-dlp executable (or just "yt-dlp" if in PATH).')
            .addText(text => text
                .setValue(this.plugin.data.settings.youtubeDlpPath)
                .onChange(async (value) => {
                    this.plugin.data.settings.youtubeDlpPath = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('FFmpeg Binary Path')
            .setDesc('Absolute path to ffmpeg executable (optional, if not in PATH). Auto-detected if ffmpeg-static is installed.')
            .addText(text => text
                .setValue(this.plugin.data.settings.ffmpegPath)
                .onChange(async (value) => {
                    this.plugin.data.settings.ffmpegPath = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('JS Runtime Path')
            .setDesc('Absolute path to node, deno or bun (required for YouTube signature extraction).')
            .addText(text => text
                .setPlaceholder('e.g. /usr/local/bin/node')
                .setValue(this.plugin.data.settings.jsRuntimePath)
                .onChange(async (value) => {
                    this.plugin.data.settings.jsRuntimePath = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('Download Folder')
            .setDesc('Folder to save downloads (relative to vault). Leave empty to use Watched Folder.')
            .addText(text => text
                .setValue(this.plugin.data.settings.downloadFolder)
                .onChange(async (value) => {
                    this.plugin.data.settings.downloadFolder = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('Storage Limit (GB)')
            .setDesc('Manual storage limit in Gigabytes.')
            .addText(text => text
                .setPlaceholder('10')
                .setValue(String(this.plugin.data.settings.storageLimitGB || 10))
                .onChange(async (value) => {
                    const limit = parseFloat(value);
                    if (!isNaN(limit) && limit > 0) {
                        this.plugin.data.settings.storageLimitGB = limit;
                        await this.plugin.saveData();
                        void this.plugin.calculateDynamicLimit();
                    }
                }));
    }
}

class CrossPlayerListView extends ItemView {
    plugin: CrossPlayerPlugin;
    private savedScrollTop: number = 0;

    constructor(leaf: WorkspaceLeaf, plugin: CrossPlayerPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.savedScrollTop = this.plugin.data.queueScrollTop || 0;
    }

    getViewType() {
        return VIEW_TYPE_CROSS_PLAYER_LIST;
    }

    getDisplayText() {
        return "Cross Player Queue";
    }

    getIcon() {
        return "list-video";
    }

    async onOpen() {
        this.plugin.listView = this;
        this.savedScrollTop = this.plugin.data.queueScrollTop || 0;
        this.refresh();
    }

    async onClose() {
        if (this.plugin.listView === this) {
            this.plugin.listView = null;
        }
    }

    captureScrollPosition() {
        const list = this.contentEl.querySelector<HTMLElement>(".cross-player-list");
        if (!list) return;

        this.savedScrollTop = list.scrollTop;
        this.plugin.data.queueScrollTop = this.savedScrollTop;
    }

    updateStatsDisplay() {
        const stats = this.plugin.getQueueStats();
        const speed = this.plugin.data.playbackSpeed || 1.0;
        const adjustedDuration = stats.totalDuration / speed;
        const limitBytes = this.plugin.dynamicStorageLimit;
        const limitGB = limitBytes > 0 ? limitBytes / (1024 * 1024 * 1024) : 10;
        const sizeInGB = stats.totalSize / (1024 * 1024 * 1024);

        const etcEl = this.contentEl.querySelector<HTMLElement>(".cross-player-etc");
        if (etcEl) {
            etcEl.setText(`ETC: ${this.plugin.formatDuration(adjustedDuration)}`);
        }

        const sizeEl = this.contentEl.querySelector<HTMLElement>(".cross-player-size");
        if (sizeEl) {
            sizeEl.setText(`Size: ${sizeInGB.toFixed(2)} GB / ${limitGB.toFixed(1)} GB`);
            sizeEl.toggleClass('is-over-limit', sizeInGB > limitGB);
        }
    }

    getDisplayNameParts(name: string): { title: string; extension: string } {
        const lastDotIndex = name.lastIndexOf(".");
        if (lastDotIndex <= 0 || lastDotIndex === name.length - 1) {
            return { title: name, extension: "" };
        }

        return {
            title: name.slice(0, lastDotIndex),
            extension: name.slice(lastDotIndex)
        };
    }

    refresh() {
        const container = this.contentEl;
        const storedScrollTop = this.plugin.data.queueScrollTop ?? this.savedScrollTop;

        // Save scroll position before emptying
        const oldList = container.querySelector<HTMLElement>(".cross-player-list");
        if (oldList) {
            const measuredScrollTop = oldList.scrollTop;
            if (measuredScrollTop > 0 || storedScrollTop === 0) {
                this.savedScrollTop = measuredScrollTop;
                this.plugin.data.queueScrollTop = measuredScrollTop;
            } else {
                this.savedScrollTop = storedScrollTop;
            }
        }

        container.empty();
        container.addClass('cross-player-list-view');

        // --- Header (Speed and Stats) ---
        const headerContainer = container.createDiv({ cls: "cross-player-header" });
        headerContainer.addClass('cross-player-header-layout');

        // Title Row with Sort Button
        const titleRow = headerContainer.createDiv({ cls: "cross-player-title-row" });
        titleRow.createEl("h4", { text: "Media Queue", cls: "cross-player-title", attr: { style: "margin: 0;" } });

        const sortBtn = titleRow.createDiv({ cls: "clickable-icon" });
        setIcon(sortBtn, "arrow-up-down");
        sortBtn.ariaLabel = "Sort Queue";
        sortBtn.onclick = (evt) => {
            const menu = new Menu();

            menu.addItem(item => item
                .setTitle("Name (A to Z)")
                .setIcon("sort-asc")
                .onClick(() => this.plugin.sortQueue('name', 'asc')));

            menu.addItem(item => item
                .setTitle("Name (Z to A)")
                .setIcon("sort-desc")
                .onClick(() => this.plugin.sortQueue('name', 'desc')));

            menu.addSeparator();

            menu.addItem(item => item
                .setTitle("Type (A to Z)")
                .setIcon("file")
                .onClick(() => this.plugin.sortQueue('type', 'asc')));

            menu.addItem(item => item
                .setTitle("Type (Z to A)")
                .setIcon("file")
                .onClick(() => this.plugin.sortQueue('type', 'desc')));

            menu.addSeparator();

            menu.addItem(item => item
                .setTitle("Size (Smallest)")
                .setIcon("chevrons-down")
                .onClick(() => this.plugin.sortQueue('size', 'asc')));

            menu.addItem(item => item
                .setTitle("Size (Largest)")
                .setIcon("chevrons-up")
                .onClick(() => this.plugin.sortQueue('size', 'desc')));

            menu.showAtMouseEvent(evt);
        };

        const refreshBtn = titleRow.createDiv({ cls: "clickable-icon" });
        setIcon(refreshBtn, "refresh-cw");
        refreshBtn.ariaLabel = "Refresh Data";
        refreshBtn.onclick = () => {
            void this.plugin.reloadSyncedDataIfChanged(true).then(() => {
                new Notice("Data reloaded.");
            });
        };

        const cleanBtn = titleRow.createDiv({ cls: "clickable-icon" });
        setIcon(cleanBtn, "trash-2");
        cleanBtn.ariaLabel = "Clean Consumed Media";
        cleanBtn.onclick = () => {
            new ConfirmCleanConsumedMediaModal(this.app, this.plugin).open();
        };

        const speed = this.plugin.data.playbackSpeed || 1.0;
        const speedContainer = headerContainer.createDiv({ cls: "cross-player-speed-container" });
        const minusBtn = speedContainer.createDiv({ cls: "clickable-icon" });
        setIcon(minusBtn, "minus-circle");
        minusBtn.ariaLabel = "Decrease Speed";
        minusBtn.onclick = async () => {
            this.captureScrollPosition();
            if (this.plugin.mainView) {
                await this.plugin.mainView.changePlaybackSpeed(-0.1);
            } else {
                // Fallback if main view isn't open but we want to change default
                const newSpeed = Math.max(0.1, (this.plugin.data.playbackSpeed || 1.0) - 0.1);
                this.plugin.data.playbackSpeed = newSpeed;
                await this.plugin.saveData(false);
                this.updateSpeedDisplay();
            }
        };

        const speedEl = speedContainer.createDiv({ cls: "cross-player-speed-display" });
        speedEl.setText(`Speed: ${speed.toFixed(1)}x`);

        const plusBtn = speedContainer.createDiv({ cls: "clickable-icon" });
        setIcon(plusBtn, "plus-circle");
        plusBtn.ariaLabel = "Increase Speed";
        plusBtn.onclick = async () => {
            this.captureScrollPosition();
            if (this.plugin.mainView) {
                await this.plugin.mainView.changePlaybackSpeed(0.1);
            } else {
                const newSpeed = Math.min(10.0, (this.plugin.data.playbackSpeed || 1.0) + 0.1);
                this.plugin.data.playbackSpeed = newSpeed;
                await this.plugin.saveData(false);
                this.updateSpeedDisplay();
            }
        };

        // Stats Display
        const stats = this.plugin.getQueueStats();
        const adjustedDuration = stats.totalDuration / speed;

        // Dynamic Limit
        const limitBytes = this.plugin.dynamicStorageLimit;
        const limitGB = limitBytes > 0 ? limitBytes / (1024 * 1024 * 1024) : 10; // Default 10GB if waiting
        const sizeInGB = stats.totalSize / (1024 * 1024 * 1024);

        const statsContainer = headerContainer.createDiv({ cls: "cross-player-stats" });
        const etcText = `ETC: ${this.plugin.formatDuration(adjustedDuration)}`;
        statsContainer.createSpan({ text: etcText, cls: 'cross-player-etc' });

        statsContainer.createSpan({ text: " • " });

        const sizeSpan = statsContainer.createSpan({ text: `Size: ${sizeInGB.toFixed(2)} GB / ${limitGB.toFixed(1)} GB`, cls: 'cross-player-size' });
        sizeSpan.toggleClass('is-over-limit', sizeInGB > limitGB);

        // --- List (Scrollable) ---
        const list = container.createDiv({ cls: "cross-player-list cross-player-list-scroll" });

        // Save scroll position on scroll
        list.addEventListener('scroll', () => {
            this.savedScrollTop = list.scrollTop;
            this.plugin.data.queueScrollTop = this.savedScrollTop;
        });

        // list.style.minHeight = "0"; // Firefox fix for flex overflow

        this.plugin.data.queue.forEach((item) => {
            const itemEl = list.createDiv({ cls: "cross-player-item" });
            itemEl.dataset.id = item.id;

            // Check if item is currently playing (status 'playing' OR it is the active item in main view)
            // This prevents the "selection" color from disappearing when status changes to 'completed' at 95%
            const isPlaying = item.status === 'playing' || (this.plugin.mainView && this.plugin.mainView.currentItem && this.plugin.mainView.currentItem.id === item.id);

            if (isPlaying) {
                itemEl.addClass('is-playing');
            }

            // Progress Highlight
            const progressEl = itemEl.createDiv({ cls: "cross-player-item-progress" });
            if (this.plugin.data.settings.showProgressColor && item.duration > 0 && (item.position > 0 || item.status === 'completed')) {
                const pct = item.status === 'completed' ? 100 : Math.min(100, (item.position / item.duration) * 100);
                progressEl.setCssProps({ width: `${pct}%` });
            } else {
                progressEl.setCssProps({ width: "0%" });
            }

            // Status Icon
            const statusIcon = itemEl.createDiv({ cls: "cross-player-status-icon" });
            if (item.status === 'completed') setIcon(statusIcon, "check-circle");
            else if (item.status === 'playing') setIcon(statusIcon, "play-circle");
            else setIcon(statusIcon, "circle");
            statusIcon.addClass('cross-player-status-icon-compact');

            // Type Icon
            if (this.plugin.data.settings.showMediaIndicator) {
                const typeIcon = itemEl.createDiv({ cls: "cross-player-type-icon" });
                const ext = item.path.split('.').pop()?.toLowerCase();
                const isAudio = AUDIO_EXTENSIONS.includes(ext || '');
                setIcon(typeIcon, isAudio ? "headphones" : "film");
                typeIcon.addClass('cross-player-type-icon-muted');
            }
            // typeIcon.style.fontSize = "0.8em"; // Icon size is usually handled by setIcon/svg, might need scaling if too big, but default is usually fine for rows.
            // setIcon produces an svg. Obsidian icons are standard size.
            // Let's make it slightly smaller to be subtle? Or just normal.
            // "small visual distinction" -> maybe opacity or color or size.
            // Let's stick to color text-muted and maybe scale if needed, but standard icon size (usually 16x16 or 24x24) is fine.
            // Actually, Obsidian setIcon usually fills the container. 
            // Let's set a fixed width/height for the container to control size if needed, but usually it's fine.
            // I'll just add the element.

            // Name
            const nameEl = itemEl.createDiv({ cls: "cross-player-name" });
            nameEl.title = item.path;
            if (this.plugin.data.settings.wrapQueueText) {
                nameEl.addClass("is-wrapped");
            }

            const { title, extension } = this.getDisplayNameParts(item.name);
            nameEl.createSpan({ text: title, cls: "cross-player-name-title" });
            if (extension) {
                nameEl.createSpan({ text: extension, cls: "cross-player-name-extension" });
            }

            nameEl.addEventListener("click", (e) => {
                e.stopPropagation();
                // Always auto-play when user clicks
                void this.plugin.playMedia(item, true);
            });

            // Context Menu
            itemEl.addEventListener("contextmenu", (event) => {
                // Prevent default context menu
                event.preventDefault();
                // Stop propagation so it doesn't trigger the click handler (which plays the media)
                event.stopPropagation();

                const menu = new Menu();

                menu.addItem((menuItem) =>
                    menuItem
                        .setTitle("Delete Media")
                        .setIcon("trash")
                        .onClick(() => {
                            this.captureScrollPosition();
                            void this.plugin.deleteMediaItem(item);
                        })
                );

                menu.addItem((menuItem) =>
                    menuItem
                        .setTitle("Set as Unread")
                        .setIcon("undo")
                        .onClick(() => {
                            this.captureScrollPosition();
                            void this.plugin.setMediaItemAsUnread(item);
                        })
                );

                menu.showAtPosition({ x: event.clientX, y: event.clientY });
            });

            // Controls
            const controls = itemEl.createDiv({ cls: "cross-player-controls cross-player-controls-compact" });

            // Drag Handle
            const handle = controls.createDiv({ cls: "clickable-icon sortable-handle" });
            setIcon(handle, "grip-horizontal");
        });

        Sortable.create(list, {
            animation: 150,
            handle: '.sortable-handle',
            ghostClass: 'sortable-ghost',
            // Disable forceFallback to use native DnD (fixes mobile offset issues)
            forceFallback: false,
            delay: 100, // Short delay to prevent accidental scrolling interference
            delayOnTouchOnly: true,
            touchStartThreshold: 5,
            onSort: (evt) => {
                if (evt.oldIndex !== undefined && evt.newIndex !== undefined) {
                    // We don't want to trigger a full refresh immediately because Sortable has already moved the DOM element.
                    // But we DO want to save the new order.
                    // The issue is that saveData() calls refresh().
                    // We can optimize this by updating the data without calling refresh(), or just let it refresh.
                    // Let's just let it refresh for now to ensure consistency.
                    void this.plugin.reorderItem(evt.oldIndex, evt.newIndex);
                }
            }
        });

        // --- Download Area (Collapsible, Bottom) ---
        // Create container for download area
        const downloadContainer = container.createDiv({ cls: 'cross-player-download-container' });

        this.updateDownloadProgress(downloadContainer);

        const scrollTopToRestore = this.plugin.data.queueScrollTop ?? this.savedScrollTop;
        if (scrollTopToRestore > 0) {
            list.scrollTop = scrollTopToRestore;
            window.requestAnimationFrame(() => {
                list.scrollTop = scrollTopToRestore;
            });
        }
    }

    updateStats() {
        const statsContainer = this.contentEl.querySelector(".cross-player-stats");
        if (!statsContainer) return;

        const speed = this.plugin.data.playbackSpeed || 1.0;
        const stats = this.plugin.getQueueStats();
        const adjustedDuration = stats.totalDuration / speed;

        const limitBytes = this.plugin.dynamicStorageLimit;
        const limitGB = limitBytes > 0 ? limitBytes / (1024 * 1024 * 1024) : 10;
        const sizeInGB = stats.totalSize / (1024 * 1024 * 1024);

        statsContainer.empty();

        const etcText = `ETC: ${this.plugin.formatDuration(adjustedDuration)}`;
        statsContainer.createSpan({ text: etcText });

        statsContainer.createSpan({ text: " • " });

        const sizeSpan = statsContainer.createSpan({ text: `Size: ${sizeInGB.toFixed(2)} GB / ${limitGB.toFixed(1)} GB` });
        sizeSpan.toggleClass('is-over-limit', sizeInGB > limitGB);
    }

    updateItemProgress(id: string, percentage: number) {
        const itemEl = this.contentEl.querySelector<HTMLElement>(`.cross-player-item[data-id="${id}"]`);
        if (itemEl) {
            const progressEl = itemEl.querySelector<HTMLElement>(".cross-player-item-progress");
            if (progressEl) {
                if (!this.plugin.data.settings.showProgressColor) {
                    progressEl.setCssProps({ width: "0%" });
                    return;
                }
                const pct = Math.min(100, Math.max(0, percentage));
                progressEl.setCssProps({ width: `${pct}%` });
            }
        }
    }

    updateDownloadProgress(parentContainer?: HTMLElement) {
        // If parentContainer is provided, we are in initial render. 
        // If not, we need to find existing container.

        let container = parentContainer;
        if (!container) {
            container = this.contentEl.querySelector<HTMLElement>('.cross-player-download-container') ?? undefined;
        }

        if (!container) return; // Should exist if view is open

        container.empty();

        const activeDownloads = this.plugin.activeDownloads;
        if (activeDownloads.length === 0) {
            // Collapsed or hidden state? 
            // If empty, maybe just hide content but keep header? 
            // Or hide completely? User said "collapsible towards the bottom". 
            // If no downloads, usually hidden.
            container.addClass('is-hidden');
            return;
        } else {
            container.removeClass('is-hidden');
        }

        // Header / Toggle
        const header = container.createDiv({ cls: 'download-header' });

        header.createSpan({ text: `Downloads (${activeDownloads.length})`, attr: { style: "font-weight: bold; font-size: 0.9em;" } });
        const toggleIcon = header.createDiv();
        // We can use state to track collapsed. For now, let's default to expanded if active.
        // Actually user wants it collapsible.
        // Let's store collapsed state in class property (not persistent).
        // But refreshing wipes class property if not careful. 
        // Let's check dataset or assume expanded.

        const isCollapsed = container.dataset.collapsed === 'true';
        setIcon(toggleIcon, isCollapsed ? "chevron-up" : "chevron-down");

        const content = container.createDiv({ cls: 'download-content' });
        content.toggleClass('is-collapsed', isCollapsed);

        header.onclick = () => {
            const collapsed = container.dataset.collapsed === 'true';
            container.dataset.collapsed = String(!collapsed);
            content.toggleClass('is-collapsed', !collapsed);
            setIcon(toggleIcon, collapsed ? "chevron-down" : "chevron-up");
        };

        // Global Progress Bar
        if (activeDownloads.length > 0) {
            let totalProgress = 0;
            let count = 0;
            activeDownloads.forEach(d => {
                if (d.status === 'completed') {
                    totalProgress += 100;
                    count++;
                } else if (d.progress.includes('%')) {
                    totalProgress += parseFloat(d.progress) || 0;
                    count++;
                } else if (d.status === 'downloading' || d.status === 'paused') {
                    // if progress not yet parsed, assume 0
                    count++;
                }
            });
            const avgProgress = count > 0 ? totalProgress / count : 0;

            const globalProgressContainer = content.createDiv({ attr: { style: "margin-bottom: 10px;" } });
            globalProgressContainer.createDiv({ text: `Total Progress: ${avgProgress.toFixed(1)}%`, attr: { style: "font-size: 0.8em; margin-bottom: 2px; color: var(--text-muted);" } });
            const globalBar = globalProgressContainer.createEl("progress");
            globalBar.addClass('cross-player-global-progress');
            globalBar.value = avgProgress;
            globalBar.max = 100;
        }

        activeDownloads.forEach(dl => {
            const dlItem = content.createDiv({ cls: 'download-item' });

            // 1. Name
            const nameRow = dlItem.createDiv({ attr: { style: "display: flex; justify-content: space-between; margin-bottom: 2px;" } });
            nameRow.createSpan({ text: dl.name, attr: { style: "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; font-weight: bold;" } });

            let statusText = dl.progress;
            if (dl.status === 'error') statusText = 'Error';
            else if (dl.status === 'paused') statusText = 'Paused';
            else if (dl.status === 'converting') statusText = 'Converting...';

            nameRow.createSpan({ text: statusText });

            // 2. Progress Bar
            const progressBar = dlItem.createEl("progress");
            progressBar.addClass('cross-player-download-progress');
            if (dl.progress.includes('%')) {
                progressBar.value = parseFloat(dl.progress) || 0;
            } else {
                progressBar.value = 0;
            }
            progressBar.max = 100;

            // 3. Info & Controls
            const controlsRow = dlItem.createDiv({ attr: { style: "display: flex; justify-content: space-between; align-items: center; margin-top: 2px;" } });

            const info = controlsRow.createDiv({ attr: { style: "color: var(--text-muted); font-size: 0.9em;" } });
            if (dl.status === 'downloading') {
                info.setText(`${dl.speed} - ETA: ${dl.eta}`);
            } else if (dl.status === 'converting') {
                info.setText('Processing media...');
            } else if (dl.status === 'error') {
                info.setText(dl.error || "Unknown Error");
                info.addClass('cross-player-download-error');
            }

            const btnGroup = controlsRow.createDiv({ attr: { style: "display: flex; gap: 5px;" } });

            // Pause/Resume Button
            if (dl.status === 'downloading') {
                const pauseBtn = btnGroup.createEl("button", { text: "Pause" });
                pauseBtn.addClass('cross-player-download-button');
                pauseBtn.onclick = () => this.plugin.pauseDownload(dl.id);
            } else if (dl.status === 'paused') {
                const resumeBtn = btnGroup.createEl("button", { text: "Resume" });
                resumeBtn.addClass('cross-player-download-button');
                resumeBtn.onclick = () => this.plugin.resumeDownload(dl.id);
            } else if (dl.status === 'error') {
                const retryBtn = btnGroup.createEl("button", { text: "Retry" });
                retryBtn.addClass('cross-player-download-button');
                retryBtn.onclick = () => this.plugin.retryDownload(dl.id);
            }

            // Cancel Button
            const cancelBtn = btnGroup.createEl("button", { text: "Cancel" });
            cancelBtn.addClass('cross-player-download-button');
            cancelBtn.onclick = () => this.plugin.cancelDownload(dl.id);
        });
    }

    updateSpeedDisplay() {
        const speedEl = this.contentEl.querySelector<HTMLElement>(".cross-player-speed-display");
        if (speedEl) {
            const speed = this.plugin.data.playbackSpeed || 1.0;
            speedEl.setText(`Speed: ${speed.toFixed(1)}x`);
            this.updateStatsDisplay();
        }
    }

}

class CrossPlayerMainView extends ItemView {
    plugin: CrossPlayerPlugin;
    videoEl: HTMLVideoElement;
    videoWrapperEl: HTMLDivElement; // Added wrapper property
    overlayEl: HTMLElement | null = null;
    overlayProgressEl: HTMLInputElement | null = null;
    overlayProgressWrapEl: HTMLElement | null = null;
    overlayCurrentTimeEl: HTMLElement | null = null;
    overlayDurationEl: HTMLElement | null = null;
    overlayFullscreenBtn: HTMLElement | null = null;
    audioPlaceholderEl: HTMLElement | null = null;
    currentItem: MediaItem | null = null;
    lastEtcUpdate: number = 0;
    lastProgressUpdate: number = 0;
    audioContext: AudioContext | null = null;
    mediaSourceNode: MediaElementAudioSourceNode | null = null;
    gainNode: GainNode | null = null;
    compressorNode: DynamicsCompressorNode | null = null;
    mobileOverlayHideTimeout: number | null = null;
    activeMediaSrc: string | null = null;
    lastPositionPersist: number = 0;

    constructor(leaf: WorkspaceLeaf, plugin: CrossPlayerPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getOverlayProgressBottomOffset(): string {
        if (activeDocument.fullscreenElement) {
            return "18px";
        }

        if (Platform.isTablet) {
            return "18px";
        }

        if (Platform.isMobile) {
            return "max(56px, calc(env(safe-area-inset-bottom, 0px) + 12px))";
        }

        return "18px";
    }

    getViewType() {
        return VIEW_TYPE_CROSS_PLAYER_MAIN;
    }

    getDisplayText() {
        return this.currentItem ? this.currentItem.name : "Cross Player";
    }

    getIcon() {
        return "play";
    }

    setViewTitle(title: string) {
        const viewWithTitles = this.leaf.view as ItemView & {
            headerTitleEl?: { setText(text: string): void };
            titleEl?: { setText(text: string): void };
        };
        if (viewWithTitles.headerTitleEl) {
            viewWithTitles.headerTitleEl.setText(title);
        } else if (viewWithTitles.titleEl) {
            viewWithTitles.titleEl.setText(title);
        }
    }

    isCurrentPlaybackSource() {
        if (!this.videoEl || !this.currentItem || !this.activeMediaSrc) return false;
        const currentSrc = this.videoEl.currentSrc || this.videoEl.src;
        return currentSrc === this.activeMediaSrc;
    }

    isActivelyPlayingLocally() {
        return !!this.videoEl && this.isCurrentPlaybackSource() && !this.videoEl.paused && !this.videoEl.ended;
    }

    async syncCurrentItemDuration() {
        if (!this.videoEl || !this.currentItem || !isFinite(this.videoEl.duration) || this.videoEl.duration <= 0) {
            return;
        }

        const actualDuration = this.videoEl.duration;
        if (Math.abs((this.currentItem.duration || 0) - actualDuration) <= 1) {
            return;
        }

        this.currentItem.duration = actualDuration;
        await this.plugin.saveData(false);

        if (this.plugin.listView) {
            this.plugin.listView.updateStats();
        }
    }

    async persistCurrentPlaybackPosition(force: boolean = false) {
        if (!this.videoEl || !this.currentItem || !this.isCurrentPlaybackSource() || !isFinite(this.videoEl.currentTime)) {
            return;
        }

        await this.plugin.updatePosition(this.currentItem.id, this.videoEl.currentTime, force);
    }

    async syncCompletionStatusFromPlayback() {
        if (
            !this.videoEl ||
            !this.currentItem ||
            !this.isCurrentPlaybackSource() ||
            this.currentItem.status === 'completed' ||
            !isFinite(this.videoEl.duration) ||
            this.videoEl.duration <= 0
        ) {
            return;
        }

        const progress = this.videoEl.currentTime / this.videoEl.duration;
        if (progress > 0.95) {
            await this.plugin.updateStatus(this.currentItem.id, 'completed');
        }
    }

    async persistPlaybackSnapshotOnClose() {
        if (!this.currentItem) return;

        const queueItem = this.plugin.data.queue.find(item => item.id === this.currentItem?.id)
            || this.plugin.data.queue.find(item => item.path === this.currentItem?.path);
        if (!queueItem) return;

        const currentTime = this.videoEl && isFinite(this.videoEl.currentTime)
            ? this.videoEl.currentTime
            : (queueItem.position || 0);
        const duration = this.videoEl && isFinite(this.videoEl.duration) && this.videoEl.duration > 0
            ? this.videoEl.duration
            : (queueItem.duration || 0);

        queueItem.position = currentTime;
        this.currentItem.position = currentTime;
        this.plugin.markPlaybackStateChanged(queueItem);

        if (duration > 0 && Math.abs((queueItem.duration || 0) - duration) > 1) {
            queueItem.duration = duration;
        }
        this.currentItem.duration = queueItem.duration;

        const progress = duration > 0 ? currentTime / duration : 0;
        if (progress > 0.95) {
            queueItem.status = 'completed';
            queueItem.finished = true;
            this.plugin.recordConsumption(queueItem);
            this.currentItem.status = 'completed';
            this.currentItem.finished = true;
            this.plugin.markPlaybackStateChanged(queueItem);
        } else if (queueItem.status === 'playing') {
            queueItem.status = queueItem.finished ? 'completed' : 'pending';
            this.currentItem.status = queueItem.status;
            this.plugin.markPlaybackStateChanged(queueItem);
        }

        await this.plugin.saveData();
    }

    handleSyncedDataReload() {
        if (!this.currentItem) return;

        const syncedItem = this.plugin.data.queue.find(item => item.id === this.currentItem?.id)
            || this.plugin.data.queue.find(item => item.path === this.currentItem?.path);
        if (!syncedItem) return;

        const isActivelyPlayingLocally = !!this.videoEl && this.isCurrentPlaybackSource() && !this.videoEl.paused && !this.videoEl.ended;
        this.currentItem = syncedItem;

        // When this device is not actively playing, trust the synced position.
        if (this.videoEl && !isActivelyPlayingLocally && isFinite(this.videoEl.duration) && this.videoEl.duration > 0) {
            const targetPosition = Math.max(0, Math.min(this.videoEl.duration, syncedItem.position || 0));
            if (Math.abs(this.videoEl.currentTime - targetPosition) > 1) {
                this.videoEl.currentTime = targetPosition;
            }
        }

        this.updateOverlayProgress();
        if (this.plugin.listView) {
            this.plugin.listView.updateStats();
        }
    }

    async onOpen() {
        this.plugin.mainView = this;
        const container = this.contentEl;
        container.empty();
        container.addClass("cross-player-main-view");
        // Make the view focusable so it can receive keyboard events
        container.tabIndex = 0;
        container.addClass('cross-player-no-outline');

        // Keyboard shortcuts handler
        container.addEventListener('keydown', (e) => {
            if (!this.videoEl) return;

            // If the video element itself has focus, let default controls handle it
            if (activeDocument.activeElement === this.videoEl) return;

            // Ignore if user is typing in an input (unlikely here but good practice)
            if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

            const { seekSecondsForward, seekSecondsBackward } = this.plugin.data.settings;

            switch (e.key) {
                case ' ':
                case 'Spacebar':
                    e.preventDefault();
                    if (this.videoEl.paused) {
                        void this.videoEl.play();
                    } else {
                        this.videoEl.pause();
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.videoEl.currentTime = Math.min(this.videoEl.duration, this.videoEl.currentTime + seekSecondsForward);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    this.videoEl.currentTime = Math.max(0, this.videoEl.currentTime - seekSecondsBackward);
                    break;
            }
        });

        // Wrapper for video and overlay to manage events cleanly
        this.videoWrapperEl = container.createDiv({ cls: 'cross-player-video-wrapper' });

        this.videoEl = this.videoWrapperEl.createEl("video");
        this.videoEl.controls = !this.shouldUseTouchOverlay();
        this.videoEl.addClass('cross-player-media-element');

        this.registerDomEvent(activeDocument, 'fullscreenchange', () => {
            window.setTimeout(() => {
                this.refreshMobileOverlay();
                if (this.overlayProgressWrapEl) {
                    this.overlayProgressWrapEl.setCssProps({ bottom: this.getOverlayProgressBottomOffset() });
                }
            }, 50);
        });

        this.showIdlePlaceholder();
        this.refreshMobileOverlay();

        this.videoEl.onended = async () => {
            if (this.currentItem && this.isCurrentPlaybackSource()) {
                await this.persistCurrentPlaybackPosition(true);
                await this.syncCompletionStatusFromPlayback();

                // If onended fires, it's definitely completed
                if (this.currentItem.status !== 'completed') {
                    await this.plugin.updateStatus(this.currentItem.id, 'completed');
                }

                // Check autoplay regardless of whether it was already marked completed
                if (this.plugin.data.settings.autoplayNext) {
                    void this.plugin.playNextUnread();
                }
            }

            void this.plugin.flushDeferredMetadataHydration();
        };

        this.videoEl.ontimeupdate = async () => {
            if (this.currentItem && this.isCurrentPlaybackSource()) {
                // Throttled ETC update in List View
                const now = Date.now();
                // Update every 5 seconds (5000ms) to reflect progress in ETC without spamming updates
                if (now - this.lastEtcUpdate > 5000) {
                    this.lastEtcUpdate = now;
                    if (this.plugin.listView) {
                        this.plugin.listView.updateStats();
                    }
                }

                if (now - this.lastPositionPersist > 5000) {
                    this.lastPositionPersist = now;
                    await this.persistCurrentPlaybackPosition();
                }

                // Throttled Progress Bar update (every 1s)
                if (now - this.lastProgressUpdate > 1000) {
                    this.lastProgressUpdate = now;
                    if (this.plugin.listView && this.plugin.data.settings.showProgressColor && this.videoEl.duration > 0) {
                        const pct = (this.videoEl.currentTime / this.videoEl.duration) * 100;
                        this.plugin.listView.updateItemProgress(this.currentItem.id, pct);
                    }
                }

                this.updateOverlayProgress();

                // Mark as completed if > 95% watched
                await this.syncCompletionStatusFromPlayback();
            }
        };

        this.videoEl.onpause = async () => {
            if (this.currentItem && this.isCurrentPlaybackSource()) {
                await this.persistCurrentPlaybackPosition(true);
            }
            void this.plugin.flushDeferredMetadataHydration();
            this.updateOverlayProgress();
        };
    }

    async onClose() {
        if (this.videoEl) {
            this.videoEl.pause();
            await this.persistPlaybackSnapshotOnClose();
            this.videoEl.removeAttribute('src');
            this.videoEl.load();
        }

        this.activeMediaSrc = null;
        this.currentItem = null;
        this.lastPositionPersist = 0;
        if (this.plugin.mainView === this) {
            this.plugin.mainView = null;
        }
        this.contentEl.empty();
    }

    refreshMobileOverlay() {
        const container = this.videoWrapperEl || this.contentEl;
        const shouldShow = this.shouldUseTouchOverlay();

        if (!shouldShow) {
            if (this.overlayEl) {
                this.overlayEl.remove();
                this.overlayEl = null;
            }
            this.overlayProgressEl = null;
            this.overlayProgressWrapEl = null;
            if (this.videoEl) {
                this.videoEl.controls = true;
            }
            return;
        }

        if (this.videoEl) {
            this.videoEl.controls = false;
        }

        if (!this.overlayEl || !container.contains(this.overlayEl)) {
            if (this.overlayEl) {
                this.overlayEl.remove();
            }
            this.createMobileOverlay(container);
        }
    }

    createMobileOverlay(container: HTMLElement) {
        const overlay = container.createDiv({ cls: 'cross-player-overlay' });
        this.overlayEl = overlay;
        overlay.addClass('cross-player-mobile-overlay');

        let suppressControlTapUntil = 0;

        const setOverlayVisibility = (visible: boolean) => {
            if (visible) {
                overlay.addClass('is-visible');
            } else {
                overlay.removeClass('is-visible');
            }
        };

        const shouldSuppressControlAction = (event?: Event) => {
            if (Date.now() < suppressControlTapUntil) {
                event?.preventDefault();
                event?.stopPropagation();
                return true;
            }
            return false;
        };

        const showOverlay = () => {
            setOverlayVisibility(true);
            this.updateOverlayProgress();

            if (this.mobileOverlayHideTimeout !== null) {
                window.clearTimeout(this.mobileOverlayHideTimeout);
            }

            this.mobileOverlayHideTimeout = window.setTimeout(() => {
                setOverlayVisibility(false);
                this.mobileOverlayHideTimeout = null;
            }, 3000);
        };

        const hideOverlay = () => {
            setOverlayVisibility(false);
            if (this.mobileOverlayHideTimeout !== null) {
                window.clearTimeout(this.mobileOverlayHideTimeout);
                this.mobileOverlayHideTimeout = null;
            }
        };

        let pointerStartTime = 0;
        let pointerStartX = 0;
        let pointerStartY = 0;
        let pointerMoved = false;

        const isOverlayVisible = () => overlay.hasClass('is-visible');

        const isProgressWrapInteractive = () => {
            const progressWrapEl = this.overlayProgressWrapEl;
            return Boolean(
                progressWrapEl &&
                isOverlayVisible() &&
                overlay.hasClass('is-visible')
            );
        };

        const isOverlayControlTarget = (target: Element | null) => {
            if (!target || !isOverlayVisible()) return false;

            if (target.closest('.cross-player-big-btn')) {
                return true;
            }

            if (!isProgressWrapInteractive()) {
                return false;
            }

            return Boolean(
                target.closest('.cross-player-overlay-progress') ||
                target.closest('.cross-player-overlay-progress-wrap')
            );
        };

        const handlePlayerTap = (target: Element | null, event: Event) => {
            if (!isOverlayVisible()) {
                event.preventDefault();
                event.stopPropagation();
                suppressControlTapUntil = Date.now() + 400;
                if (this.plugin.data.settings.pauseOnMobileTap && !this.videoEl.paused) {
                    this.videoEl.pause();
                    const playBtn = overlay.querySelector<HTMLElement>('.play-btn');
                    if (playBtn) setIcon(playBtn, "play");
                }
                showOverlay();
                return;
            }

            if (isOverlayControlTarget(target)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            hideOverlay();
        };

        const onPointerDown = (e: PointerEvent) => {
            if (!e.isPrimary) return;
            pointerStartTime = Date.now();
            pointerStartX = e.clientX;
            pointerStartY = e.clientY;
            pointerMoved = false;
        };

        const onPointerMove = (e: PointerEvent) => {
            if (!e.isPrimary) return;
            if (Math.abs(e.clientX - pointerStartX) > 10 || Math.abs(e.clientY - pointerStartY) > 10) {
                pointerMoved = true;
            }
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!e.isPrimary || pointerMoved) return;
            if (Date.now() - pointerStartTime > 500) return;
            handlePlayerTap(e.target instanceof Element ? e.target : null, e);
        };

        const onPointerCancel = () => {
            pointerMoved = true;
        };

        container.addEventListener('pointerdown', onPointerDown);
        container.addEventListener('pointermove', onPointerMove);
        container.addEventListener('pointerup', onPointerUp);
        container.addEventListener('pointercancel', onPointerCancel);

        if (this.videoEl) {
            this.videoEl.onclick = null;
        }

        const progressWrap = overlay.createDiv({ cls: 'cross-player-overlay-progress-wrap' });
        this.overlayProgressWrapEl = progressWrap;
        progressWrap.setCssProps({ bottom: this.getOverlayProgressBottomOffset() });

        const currentTimeEl = progressWrap.createSpan({ text: "0:00", cls: 'cross-player-overlay-time cross-player-overlay-time-current' });
        this.overlayCurrentTimeEl = currentTimeEl;

        const progressBarShell = progressWrap.createDiv({ cls: 'cross-player-overlay-progress-shell' });

        const progressBar = progressBarShell.createEl('input', {
            type: 'range',
            cls: 'cross-player-overlay-progress'
        });
        progressBar.min = '0';
        progressBar.max = '1000';
        progressBar.step = '1';
        progressBar.value = '0';
        this.overlayProgressEl = progressBar;

        const durationEl = progressWrap.createSpan({ text: "0:00", cls: 'cross-player-overlay-time cross-player-overlay-time-duration' });
        this.overlayDurationEl = durationEl;

        const progressFullscreenBtn = progressWrap.createDiv({ cls: 'cross-player-big-btn' });
        progressFullscreenBtn.addClass('cross-player-overlay-mini-btn');
        setIcon(progressFullscreenBtn, activeDocument.fullscreenElement ? "minimize" : "maximize");
        this.styleBigButton(progressFullscreenBtn);
        this.overlayFullscreenBtn = progressFullscreenBtn;
        progressFullscreenBtn.onclick = (e) => {
            if (shouldSuppressControlAction(e)) return;
            e.stopPropagation();
            this.toggleFullscreen();
            window.setTimeout(() => {
                if (this.overlayFullscreenBtn) {
                    setIcon(this.overlayFullscreenBtn, activeDocument.fullscreenElement ? "minimize" : "maximize");
                }
                showOverlay();
            }, 80);
        };

        const seekFromValue = (value: number) => {
            if (!this.videoEl || !isFinite(this.videoEl.duration) || this.videoEl.duration <= 0) return;

            const pct = Math.min(1, Math.max(0, value / 1000));
            this.videoEl.currentTime = this.videoEl.duration * pct;
            this.updateOverlayProgress();
            showOverlay();
        };

        const seekFromClientX = (clientX: number) => {
            const rect = progressBarShell.getBoundingClientRect();
            if (rect.width <= 0) return;
            const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            const value = Math.round(pct * 1000);
            progressBar.value = String(value);
            seekFromValue(value);
        };

        const stopProgressGesture = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
        };

        const seekFromProgress = (e: Event) => {
            if (!isProgressWrapInteractive()) return;
            if (shouldSuppressControlAction(e)) return;
            stopProgressGesture(e);
            seekFromValue(Number(progressBar.value));
        };

        progressBar.addEventListener('input', seekFromProgress);
        progressBar.addEventListener('change', seekFromProgress);

        progressBarShell.addEventListener('click', (e: MouseEvent) => {
            if (!isProgressWrapInteractive()) return;
            if (shouldSuppressControlAction(e)) return;
            stopProgressGesture(e);
            seekFromClientX(e.clientX);
        });

        progressBarShell.addEventListener('touchstart', (e: TouchEvent) => {
            if (!isProgressWrapInteractive()) return;
            if (shouldSuppressControlAction(e)) return;
            if (e.touches.length === 0) return;
            stopProgressGesture(e);
            seekFromClientX(e.touches[0].clientX);
        }, { passive: false });

        progressBarShell.addEventListener('touchmove', (e: TouchEvent) => {
            if (!isProgressWrapInteractive()) return;
            if (shouldSuppressControlAction(e)) return;
            if (e.touches.length === 0) return;
            stopProgressGesture(e);
            seekFromClientX(e.touches[0].clientX);
        }, { passive: false });

        progressBarShell.addEventListener('touchend', (e: TouchEvent) => {
            if (!isProgressWrapInteractive()) return;
            if (shouldSuppressControlAction(e)) return;
            stopProgressGesture(e);
        }, { passive: false });

        const controlsRow = overlay.createDiv({ cls: 'cross-player-controls-row' });

        // Previous Button
        const prevBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn' });
        setIcon(prevBtn, "skip-back");
        this.styleBigButton(prevBtn);
        prevBtn.onclick = async (e) => {
            if (shouldSuppressControlAction(e)) return;
            e.stopPropagation();
            await this.plugin.playPreviousItem();
            showOverlay();
        };

        // Seek Back
        const seekBackBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn' });
        setIcon(seekBackBtn, "rewind");
        this.styleBigButton(seekBackBtn);
        seekBackBtn.onclick = (e) => {
            if (shouldSuppressControlAction(e)) return;
            e.stopPropagation();
            this.seek(-this.plugin.data.settings.seekSecondsBackward);
            showOverlay();
        };

        // Play/Pause
        const playPauseBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn play-btn' });
        setIcon(playPauseBtn, "pause"); // Default to pause as we auto-play usually
        this.styleBigButton(playPauseBtn);

        playPauseBtn.onclick = (e) => {
            if (shouldSuppressControlAction(e)) return;
            e.stopPropagation();
            if (this.videoEl.paused) {
                void this.videoEl.play();
                setIcon(playPauseBtn, "pause");
            } else {
                this.videoEl.pause();
                setIcon(playPauseBtn, "play");
            }
            showOverlay();
        };

        // Update icon on state change without replacing playback listeners.
        this.videoEl.addEventListener('play', () => setIcon(playPauseBtn, "pause"));
        this.videoEl.addEventListener('pause', () => setIcon(playPauseBtn, "play"));

        // Seek Forward
        const seekFwdBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn' });
        setIcon(seekFwdBtn, "fast-forward");
        this.styleBigButton(seekFwdBtn);
        seekFwdBtn.onclick = (e) => {
            if (shouldSuppressControlAction(e)) return;
            e.stopPropagation();
            this.seek(this.plugin.data.settings.seekSecondsForward);
            showOverlay();
        };

        // Next Button
        const nextBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn' });
        setIcon(nextBtn, "skip-forward");
        this.styleBigButton(nextBtn);
        nextBtn.onclick = async (e) => {
            if (shouldSuppressControlAction(e)) return;
            e.stopPropagation();
            await this.plugin.playNextItem();
            showOverlay();
        };

        showOverlay();
    }

    updateOverlayProgress() {
        if (!this.overlayProgressEl || !this.videoEl || !isFinite(this.videoEl.duration) || this.videoEl.duration <= 0) {
            if (this.overlayProgressEl) {
                this.overlayProgressEl.value = '0';
                this.updateOverlayProgressTrack(0);
            }
            if (this.overlayCurrentTimeEl) {
                this.overlayCurrentTimeEl.setText("0:00");
            }
            if (this.overlayDurationEl) {
                this.overlayDurationEl.setText("0:00");
            }
            if (this.overlayFullscreenBtn) {
                setIcon(this.overlayFullscreenBtn, activeDocument.fullscreenElement ? "minimize" : "maximize");
            }
            return;
        }

        const pct = Math.min(1, Math.max(0, this.videoEl.currentTime / this.videoEl.duration));
        this.overlayProgressEl.value = String(Math.round(pct * 1000));
        this.updateOverlayProgressTrack(pct);
        if (this.overlayCurrentTimeEl) {
            this.overlayCurrentTimeEl.setText(this.formatPlaybackTime(this.videoEl.currentTime));
        }
        if (this.overlayDurationEl) {
            this.overlayDurationEl.setText(this.formatPlaybackTime(this.videoEl.duration));
        }
        if (this.overlayFullscreenBtn) {
            setIcon(this.overlayFullscreenBtn, activeDocument.fullscreenElement ? "minimize" : "maximize");
        }
    }

    updateOverlayProgressTrack(progress: number) {
        if (!this.overlayProgressEl) return;

        const normalized = Math.min(1, Math.max(0, progress));
        const percent = (normalized * 100).toFixed(2);
        const isDarkTheme = activeDocument.body.classList.contains('theme-dark');
        const fillColor = "var(--interactive-accent)";
        const trackColor = isDarkTheme ? "rgba(255, 255, 255, 0.22)" : "rgba(0, 0, 0, 0.10)";

        this.overlayProgressEl.setCssProps({
            '--cross-player-progress-background': `linear-gradient(to right, ${fillColor} 0%, ${fillColor} ${percent}%, ${trackColor} ${percent}%, ${trackColor} 100%)`,
            '--cross-player-progress-shadow': isDarkTheme ? "0 0 0 1px rgba(255, 255, 255, 0.05) inset" : "none"
        });
    }

    formatPlaybackTime(seconds: number): string {
        if (!isFinite(seconds) || seconds < 0) return "0:00";

        const totalSeconds = Math.floor(seconds);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const secs = totalSeconds % 60;

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }

        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    ensureAudioNodes() {
        if (!this.videoEl) return;
        if (!this.audioContext) {
            const runtimeWindow = window as AudioContextWindow;
            const AudioContextCtor = runtimeWindow.AudioContext ?? runtimeWindow.webkitAudioContext;
            if (!AudioContextCtor) return;
            this.audioContext = new AudioContextCtor();
        }

        if (!this.mediaSourceNode) {
            this.mediaSourceNode = this.audioContext.createMediaElementSource(this.videoEl);
            this.gainNode = this.audioContext.createGain();
            this.compressorNode = this.audioContext.createDynamicsCompressor();

            this.compressorNode.threshold.value = -24;
            this.compressorNode.knee.value = 30;
            this.compressorNode.ratio.value = 8;
            this.compressorNode.attack.value = 0.003;
            this.compressorNode.release.value = 0.25;

            this.mediaSourceNode.connect(this.gainNode);
            this.gainNode.connect(this.compressorNode);
            this.compressorNode.connect(this.audioContext.destination);
        }
    }

    applyAudioSettings() {
        try {
            this.ensureAudioNodes();
            if (!this.gainNode || !this.compressorNode) return;

            const boost = Math.max(100, this.plugin.data.settings.volumeBoostPercent || 100);
            this.gainNode.gain.value = boost / 100;

            if (this.plugin.data.settings.soundNormalization) {
                this.compressorNode.threshold.value = -24;
                this.compressorNode.ratio.value = 8;
            } else {
                this.compressorNode.threshold.value = 0;
                this.compressorNode.ratio.value = 1;
            }

            if (this.audioContext && this.audioContext.state === 'suspended') {
                this.audioContext.resume().catch(() => undefined);
            }
        } catch (error) {
            console.error('Failed to apply audio settings', error);
        }
    }

    styleBigButton(btn: HTMLElement) {
        btn.addClass("cross-player-overlay-btn");
    }

    shouldUseTouchOverlay() {
        return Platform.isMobile || Platform.isTablet;
    }

    ensurePlaceholderContainer() {
        if (!this.videoWrapperEl) return;

        const needsNewContainer = !this.audioPlaceholderEl || this.audioPlaceholderEl.parentElement !== this.videoWrapperEl;
        if (needsNewContainer) {
            if (this.audioPlaceholderEl) {
                this.audioPlaceholderEl.remove();
            }
            this.audioPlaceholderEl = this.videoWrapperEl.createDiv({ cls: 'cross-player-audio-placeholder' });
        } else {
            this.audioPlaceholderEl.removeClass('is-hidden');
            this.audioPlaceholderEl.empty();
        }
    }

    showIdlePlaceholder() {
        this.ensurePlaceholderContainer();
        if (!this.audioPlaceholderEl || !this.videoEl) return;
        this.contentEl.removeClass('is-media-active');
        this.videoWrapperEl?.removeClass('is-video-active');

        const badge = this.audioPlaceholderEl.createDiv({ cls: 'cross-player-idle-badge' });

        const iconEl = badge.createDiv({ cls: 'cross-player-idle-badge-icon' });
        setIcon(iconEl, "play-circle");

        this.audioPlaceholderEl.createDiv({ text: "Nothing is playing", cls: 'cross-player-placeholder-title' });

        this.audioPlaceholderEl.createDiv({ text: "Pick something from the queue to start playback.", cls: 'cross-player-placeholder-description' });

        this.videoEl.poster = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        this.videoEl.addClass('is-hidden');
        this.videoEl.removeClass('is-audio-controls');
    }

    showAudioPlaceholder() {
        this.ensurePlaceholderContainer();
        if (!this.audioPlaceholderEl || !this.videoEl) return;
        this.contentEl.addClass('is-media-active');
        this.videoWrapperEl?.removeClass('is-video-active');

        const musicIconEl = this.audioPlaceholderEl.createDiv({ cls: 'cross-player-music-icon' });
        setIcon(musicIconEl, "music");

        this.videoEl.poster = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        this.videoEl.removeClass('is-hidden');
        this.videoEl.addClass('is-audio-controls');
    }

    hidePlaceholder() {
        if (this.audioPlaceholderEl) {
            this.audioPlaceholderEl.addClass('is-hidden');
        }
        if (this.videoEl) {
            this.videoEl.removeClass('is-hidden');
            this.videoEl.removeClass('is-audio-controls');
        }
        this.contentEl.addClass('is-media-active');
    }

    clearCurrentMedia() {
        if (this.mobileOverlayHideTimeout !== null) {
            window.clearTimeout(this.mobileOverlayHideTimeout);
            this.mobileOverlayHideTimeout = null;
        }

        this.currentItem = null;
        this.activeMediaSrc = null;
        this.lastPositionPersist = 0;

        if (this.videoEl) {
            this.videoEl.pause();
            this.videoEl.removeAttribute('src');
            this.videoEl.load();
        }

        this.setViewTitle("Cross Player");
        this.showIdlePlaceholder();
        this.refreshMobileOverlay();
        this.updateOverlayProgress();
    }

    async stop() {
        if (this.videoEl) {
            // 1. Pause immediately to freeze currentTime
            this.videoEl.pause();

            // 2. Save current position if we have an active item
            if (this.currentItem) {
                await this.syncCurrentItemDuration();
                await this.persistCurrentPlaybackPosition(true);
                await this.syncCompletionStatusFromPlayback();
            }

            // 3. Clear sources and listeners
            this.videoEl.removeAttribute('src');
            this.videoEl.load();
        }
        this.clearCurrentMedia();
    }

    async play(item: MediaItem, autoPlay: boolean = false): Promise<boolean> {
        this.currentItem = item;

        // Update view title
        this.setViewTitle(item.name);

        if (!this.videoEl) {
            // Re-create if missing (unlikely if view is open)
            const container = this.contentEl;
            this.videoEl = container.createEl("video");
            this.videoEl.controls = !this.shouldUseTouchOverlay();
            this.videoEl.addClass('cross-player-media-element');
        }

        // --- Subtitle Support Preparation ---
        // Clear existing tracks
        while (this.videoEl.firstChild) {
            this.videoEl.removeChild(this.videoEl.firstChild);
        }

        const baseName = item.path.substring(0, item.path.lastIndexOf('.'));
        const subtitleExtensions = ['vtt', 'srt'];
        let sidecarFound = false;

        for (const subExt of subtitleExtensions) {
            const subPath = `${baseName}.${subExt}`;
            const subFile = this.plugin.app.vault.getAbstractFileByPath(subPath);
            if (subFile instanceof TFile) {
                this.videoEl.createEl("track", {
                    attr: {
                        kind: "subtitles",
                        label: subExt.toUpperCase(),
                        srclang: "en",
                        src: this.plugin.app.vault.getResourcePath(subFile),
                        default: "true"
                    }
                });
                sidecarFound = true;
                break; // Use the first one found
            }
        }

        // Setup listeners BEFORE setting src
        this.videoEl.onloadedmetadata = () => {
            void this.syncCurrentItemDuration();
            this.updateOverlayProgress();
            // Logic for embedded subtitles: 
            // If no sidecar was found, we try to enable the first available embedded track.
            if (!sidecarFound && this.videoEl && this.videoEl.textTracks && this.videoEl.textTracks.length > 0) {
                for (let i = 0; i < this.videoEl.textTracks.length; i++) {
                    const track = this.videoEl.textTracks[i];
                    if (track.kind === 'subtitles' || track.kind === 'captions') {
                        track.mode = 'showing';
                        break;
                    }
                }
            }
        };
        this.videoEl.ondurationchange = () => {
            void this.syncCurrentItemDuration();
            this.updateOverlayProgress();
        };

        this.videoEl.onerror = () => {
            if (!this.currentItem || !this.activeMediaSrc) {
                return;
            }
            console.error("Video playback error", this.videoEl?.error);
            new Notice("Error playing video file.");
        };

        const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
        if (file instanceof TFile) {
            const resourcePath = this.plugin.app.vault.getResourcePath(file);
            this.activeMediaSrc = resourcePath;
            this.videoEl.src = resourcePath;
        } else {
            console.error("File not found for playback:", item.path);
            this.clearCurrentMedia();
            return false;
        }

        // Context Rewind: go back 2 seconds to provide context and counter any transition-related "advance"
        const resumePosition = item.position > 2 ? item.position - 2 : item.position;
        this.videoEl.currentTime = resumePosition || 0;
        this.videoEl.playbackRate = this.plugin.data.playbackSpeed || 1.0;
        this.lastPositionPersist = 0;
        this.applyAudioSettings();

        // Handle Audio vs Video UI
        const ext = item.path.split('.').pop()?.toLowerCase();
        const isAudio = AUDIO_EXTENSIONS.includes(ext || '');
        this.contentEl.toggleClass('is-media-active', true);

        if (isAudio) {
            this.showAudioPlaceholder();
            this.videoWrapperEl.removeClass('is-video-active');
            this.videoEl.addClass('is-audio-controls');

        } else {
            // Video
            this.hidePlaceholder();
            this.videoWrapperEl.addClass('is-video-active');
            // Reset video properties
            this.videoEl.poster = "";
            this.videoEl.removeClass('is-audio-controls');
        }

        if (autoPlay) {
            try {
                await this.videoEl.play();
            } catch (e) {
                console.error("Autoplay failed", e);
            }
        }

        // Update overlay visibility based on new item type
        this.refreshMobileOverlay();
        this.updateOverlayProgress();

        return true;
    }

    async changePlaybackSpeed(delta: number) {
        if (!this.videoEl) return;
        const newSpeed = Math.max(0.1, this.videoEl.playbackRate + delta);
        this.videoEl.playbackRate = newSpeed;

        // Update persistent data
        this.plugin.data.playbackSpeed = newSpeed;
        await this.plugin.saveData(false);

        // No Notice, update UI in list view
        if (this.plugin.listView) {
            this.plugin.listView.updateSpeedDisplay();
        }
    }

    seek(seconds: number) {
        if (!this.videoEl) return;
        const newTime = Math.max(0, Math.min(this.videoEl.duration, this.videoEl.currentTime + seconds));
        this.videoEl.currentTime = newTime;
    }

    toggleFullscreen() {
        if (!this.videoEl) return;

        if (!activeDocument.fullscreenElement) {
            this.contentEl.requestFullscreen().catch((error: unknown) => {
                const message = error instanceof Error
                    ? `${error.message} (${error.name})`
                    : 'Unknown fullscreen error';
                new Notice(`Error attempting to enable full-screen mode: ${message}`);
            });
        } else {
            void activeDocument.exitFullscreen();
        }

        window.setTimeout(() => this.refreshMobileOverlay(), 50);
    }

    toggleSubtitles() {
        if (!this.videoEl || !this.videoEl.textTracks) return;

        const tracks = this.videoEl.textTracks;
        let anyShowing = false;

        for (let i = 0; i < tracks.length; i++) {
            if (tracks[i].mode === 'showing') {
                anyShowing = true;
                break;
            }
        }

        if (anyShowing) {
            for (let i = 0; i < tracks.length; i++) {
                tracks[i].mode = 'disabled';
            }
            new Notice("Subtitles disabled");
        } else {
            // Enable the first available track
            for (let i = 0; i < tracks.length; i++) {
                if (tracks[i].kind === 'subtitles' || tracks[i].kind === 'captions') {
                    tracks[i].mode = 'showing';
                    new Notice(`Subtitles enabled: ${tracks[i].label || 'Track ' + (i + 1)}`);
                    break;
                }
            }
            if (!anyShowing && tracks.length === 0) {
                const ext = this.currentItem?.path.split('.').pop()?.toLowerCase();
                if (ext === 'mkv') {
                    new Notice("No subtitle tracks found. MKV embedded subtitles (like PGS/ASS) are often not supported natively by the browser. Try an external .vtt or .srt file.");
                } else {
                    new Notice("No subtitle tracks found.");
                }
            }
        }
    }

    switchSubtitleTrack() {
        if (!this.videoEl || !this.videoEl.textTracks || this.videoEl.textTracks.length === 0) {
            new Notice("No subtitle tracks available.");
            return;
        }

        const tracks = this.videoEl.textTracks;
        const subtitleTracks: TextTrack[] = [];
        for (let i = 0; i < tracks.length; i++) {
            if (tracks[i].kind === 'subtitles' || tracks[i].kind === 'captions') {
                subtitleTracks.push(tracks[i]);
            }
        }

        if (subtitleTracks.length === 0) {
            const ext = this.currentItem?.path.split('.').pop()?.toLowerCase();
            if (ext === 'mkv') {
                new Notice("No subtitle tracks available. MKV embedded subtitles (like PGS/ASS) are often not supported natively by the browser. Try an external .vtt or .srt file.");
            } else {
                new Notice("No subtitle tracks found.");
            }
            return;
        }

        // Find current active track index
        let activeIndex = -1;
        for (let i = 0; i < subtitleTracks.length; i++) {
            if (subtitleTracks[i].mode === 'showing') {
                activeIndex = i;
                break;
            }
        }

        // Disable all
        for (let i = 0; i < subtitleTracks.length; i++) {
            subtitleTracks[i].mode = 'disabled';
        }

        // Enable next track (or cycle to first)
        const nextIndex = (activeIndex + 1) % subtitleTracks.length;
        subtitleTracks[nextIndex].mode = 'showing';

        new Notice(`Subtitle track: ${subtitleTracks[nextIndex].label || 'Track ' + (nextIndex + 1)}`);
    }
}
