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
    // Paths (vault-relative) explicitly deleted on some device, with deletion
    // timestamp (Date.now()). Used to stop stale peers from resurrecting
    // queue items via whole-queue last-writer-wins. Synced via data.json.
    // Entries older than 30 days are pruned; file existence always wins
    // (recreated files clear their tombstone).
    deletedPaths?: Record<string, number>;
    playbackSpeed: number;
    queueScrollTop?: number;
    consumptionStats?: Record<string, ConsumptionStatBucket>;
}
