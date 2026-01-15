export interface MediaItem {
    id: string;
    path: string;
    name: string;
    status: 'pending' | 'playing' | 'completed';
    position: number;
    duration: number;
    size?: number; // in bytes
}

export interface CrossPlayerSettings {
    watchedFolder: string;
    defaultPlaybackSpeed: number;
    seekSecondsForward: number;
    seekSecondsBackward: number;
    // YouTube Download Settings
    youtubeDlpPath: string;
    ffmpegPath: string;
    downloadFolder: string;
    defaultDownloadQuality: 'best' | '1080p' | '720p' | '480p' | 'audio';
    defaultDownloadType: 'video' | 'audio';
    maxStorageLimit: number; // in GB
    showMediaIndicator: boolean;
    enableMobileOverlay: boolean;
}

export interface DownloadStatus {
    id: string;
    name: string;
    progress: string;
    speed: string;
    eta: string;
    status: 'downloading' | 'paused' | 'completed' | 'error';
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
    playbackSpeed: number;
}
