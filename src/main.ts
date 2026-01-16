import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, setIcon, Notice, TFolder, TFile, FuzzySuggestModal, TAbstractFile, Menu, Modal, Platform, debounce } from 'obsidian';
// @ts-ignore
// import ffmpegStatic from 'ffmpeg-static';
import { MediaItem, CrossPlayerData, CrossPlayerSettings, DownloadStatus } from './types';
import Sortable from 'sortablejs';
import type { ChildProcess } from 'child_process';
// import * as path from 'path';
// import * as fs from 'fs';

interface ActiveDownload extends DownloadStatus {
    childProcess?: ChildProcess;
}

interface DeviceStatus {
    id: string;
    name: string;
    freeSpace: number; // in bytes
    timestamp: number;
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
    downloadFolder: '',
    defaultDownloadQuality: 'best',
    showMediaIndicator: true,
    storageLimitGB: 10
}

export default class CrossPlayerPlugin extends Plugin {
    data: CrossPlayerData;
    // No more fs watcher, we use Obsidian events
    listView: CrossPlayerListView | null = null;
    mainView: CrossPlayerMainView | null = null;
    activeDownloads: ActiveDownload[] = [];
    fsWatcher: any = null;
    debouncedReload: any;

    deviceId: string = '';
    deviceName: string = '';
    dynamicStorageLimit: number = 0; // bytes
    limitingDevice: string = '';

    debouncedUpdateDeviceStatus: any;

    async onload() {
        await this.loadData();
        this.calculateDynamicLimit();

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
                    const { spawn } = require('child_process');
                    const child = spawn(ytPath, ['--version']);
                    child.stdout.on('data', (data: Buffer) => {
                        const version = data.toString().trim();
                        new Notice(`yt-dlp version: ${version}`);
                        // Simple check: if version starts with 2021, 2022, 2023, it's likely too old given it's 2025+
                        if (version.startsWith('2021') || version.startsWith('2022') || version.startsWith('2023')) {
                            new Notice("⚠️ Your yt-dlp is very old! Please update it.");
                        }
                    });
                    child.stderr.on('data', (data: Buffer) => {
                        new Notice(`yt-dlp error: ${data.toString()}`);
                    });
                    child.on('error', (err: Error) => {
                         new Notice(`Failed to run yt-dlp: ${err.message}`);
                    });

                    // Also check ffmpeg if configured
                    const { ffmpegPath } = this.data.settings;
                    if (ffmpegPath) {
                        const ffmpegChild = spawn(ffmpegPath, ['-version']);
                        ffmpegChild.on('error', () => {
                             new Notice(`⚠️ FFmpeg not found at: ${ffmpegPath}`);
                        });
                        ffmpegChild.stdout.on('data', (data: Buffer) => {
                            if (data.toString().includes('ffmpeg version')) {
                                // detected
                            }
                        });
                    }

                } catch (e) {
                    new Notice(`Exception: ${e.message}`);
                }
            }
        });

        this.addSettingTab(new CrossPlayerSettingTab(this.app, this));

        this.registerView(
            VIEW_TYPE_CROSS_PLAYER_LIST,
            (leaf) => (this.listView = new CrossPlayerListView(leaf, this))
        );

        this.registerView(
            VIEW_TYPE_CROSS_PLAYER_MAIN,
            (leaf) => (this.mainView = new CrossPlayerMainView(leaf, this))
        );

        this.addRibbonIcon('play-circle', 'Open Cross Player', () => {
            this.activateListView();
        });

        this.addCommand({
            id: 'clean-consumed-media',
            name: 'Clean Consumed Media',
            callback: () => this.cleanConsumedMedia()
        });
        
        this.addCommand({
            id: 'open-cross-player',
            name: 'Open Cross Player',
            callback: () => {
                this.activateListView();
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
                if (this.mainView) this.mainView.changePlaybackSpeed(0.1);
            }
        });

        this.addCommand({
            id: 'decrease-playback-speed',
            name: 'Decrease Playback Speed',
            callback: () => {
                if (this.mainView) this.mainView.changePlaybackSpeed(-0.1);
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
                    this.scanFolder(this.data.settings.watchedFolder);
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
                await this.loadData();
                if (this.listView) this.listView.refresh();
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

        // Setup auto-reload for Desktop (handle Sync)
        if (Platform.isDesktop) {
            this.debouncedReload = debounce(async () => {
                 await this.loadData();
                 if (this.listView) this.listView.refresh();
            }, 1000, true);

            try {
                const path = require('path');
                const fs = require('fs');
                // @ts-ignore
                if (this.app.vault.adapter && this.app.vault.adapter.getBasePath) {
                     // @ts-ignore
                     const basePath = this.app.vault.adapter.getBasePath();
                     const dataPath = path.join(basePath, this.manifest.dir, 'data.json');
                     
                     if (fs.existsSync(dataPath)) {
                         this.fsWatcher = fs.watch(dataPath, (eventType: string) => {
                             if (eventType === 'change') {
                                 this.debouncedReload();
                             }
                         });
                     }
                }
            } catch (e) {
                console.error("Failed to setup data watcher", e);
            }
        }

        this.registerWatchers();

        if (this.data.settings.watchedFolder) {
            this.scanFolder(this.data.settings.watchedFolder);
        }

        // Initialize Device Status
        await this.loadDeviceId();
        this.updateDeviceStatus();
        
        // Removed interval check as requested, relying on file events
    }

    onunload() {
        if (this.fsWatcher) {
            this.fsWatcher.close();
            this.fsWatcher = null;
        }
    }

    async loadDeviceId() {
        // Try to load from localStorage
        let id = localStorage.getItem('cross-player-device-id');
        if (!id) {
            id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
            localStorage.setItem('cross-player-device-id', id);
        }
        this.deviceId = id;
        
        // Set device name
        let name = Platform.isMobile ? "Mobile" : "Desktop";
        if (Platform.isDesktop) {
            try {
                const os = require('os');
                name = os.hostname();
            } catch (e) {
                // fallback
            }
        } else {
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
        const loaded = await super.loadData();
        
        // Ensure settings are merged with defaults
        const settings = Object.assign({}, DEFAULT_SETTINGS, loaded ? loaded.settings : {});

        this.data = Object.assign({
            settings: settings,
            queue: [],
            // Initialize playbackSpeed with default if not present
            playbackSpeed: settings.defaultPlaybackSpeed
        }, loaded);
        
        // Ensure settings are definitely correct in data object
        this.data.settings = settings;

        // Force playbackSpeed to respect default if it's the old default (1.0) and new default is different (2.0)
        // Or if it was never set (which the above assignment handles for new users).
        // But for existing users, loaded.playbackSpeed might be 1.0.
        // The user asked to "set the default speed to 2x". 
        // If I just rely on DEFAULT_SETTINGS, existing users won't see a change if they have saved data.
        // I will trust that `loaded.playbackSpeed` is what the user *last used*.
        // If it's missing, it defaults to settings.defaultPlaybackSpeed.
    }

    async saveData() {
        await super.saveData(this.data);
        if (this.listView) this.listView.refresh();
    }

    registerWatchers() {
        // Register event
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                this.handleFileChange(file);
                // Update device status if file added
                this.debouncedUpdateDeviceStatus();
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                 // Handle rename/move
                 this.handleRename(file, oldPath);
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                this.handleDelete(file);
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
                    this.calculateDynamicLimit();
                }
            })
        );
    }

    async setWatchedFolder(path: string) {
        this.data.settings.watchedFolder = path;
        await this.saveData();
        new Notice(`Watched folder set to: ${path}`);
        
        // Just scan new folder.
        this.scanFolder(path);
    }

    async scanFolder(folderPath: string) {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (folder instanceof TFolder) {
            const files = this.app.vault.getFiles();
            const filesInFolder = files.filter(file => file.path.startsWith(folderPath + "/"));
            
            // Process all files without saving individually
            const promises = filesInFolder.map(file => this.handleFileChange(file, false));
            await Promise.all(promises);
            
            // Save once at the end
            await this.saveData();
        } else {
            console.warn("Watched path is not a folder:", folderPath);
        }
    }

    async getMediaDuration(file: TFile): Promise<number> {
        return new Promise((resolve) => {
            const video = document.createElement('video');
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
            
            if (item.status === 'pending') {
                totalDuration += item.duration;
            } else if (item.status === 'playing') {
                // Subtract current position
                totalDuration += Math.max(0, item.duration - item.position);
            }
        }
        
        return { totalDuration, totalSize };
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
                if (watchedFolder && !newPath.startsWith(watchedFolder + "/") && newPath !== watchedFolder) {
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
                 this.data.queue = this.data.queue.filter(item => {
                     // Keep if inside watched folder
                     return item.path.startsWith(watchedFolder + "/") || item.path === watchedFolder;
                 });
            }
            
            await this.saveData();
        }

        // 2. Check if the new location is inside watched folder (Move In)
        // Even if we updated paths, we might have moved a NEW folder IN.
        // If we just renamed inside, handleFileChange will check if it's already in queue.
        this.handleFileChange(file);
    }

    async handleDelete(file: TAbstractFile) {
        // If file or folder deleted, remove from queue
        const path = file.path;
        const initialLength = this.data.queue.length;
        this.data.queue = this.data.queue.filter(item => item.path !== path && !item.path.startsWith(path + "/"));
        
        if (this.data.queue.length !== initialLength) {
            await this.saveData();
        }
    }

    async handleFileChange(file: TAbstractFile, shouldSave: boolean = true) {
        const folderPath = this.data.settings.watchedFolder;
        if (!folderPath) return;

        // Ignore hidden files and folders (starting with .)
        if (file.name.startsWith('.') || file.path.includes('/.')) return;

        // Recursively handle folders
        if (file instanceof TFolder) {
            for (const child of file.children) {
                await this.handleFileChange(child, shouldSave);
            }
            return;
        }

        if (!(file instanceof TFile)) return;
        
        // Double check it is in the folder
        if (!file.path.startsWith(folderPath + "/")) return;

        const ext = file.extension.toLowerCase();
        const validExtensions = ['mp4', 'webm', 'ogv', 'mp3', 'wav', 'ogg', 'mkv'];

        if (!validExtensions.includes(ext)) return;
        
        // Check if already in queue
        const existing = this.data.queue.find(item => item.path === file.path);
        if (!existing) {
            const duration = await this.getMediaDuration(file);
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
            if (shouldSave) {
                await this.saveData();
                new Notice(`Added ${file.name} to queue`);
            }
        } else {
             // Update duration/size if missing (migration)
             let changed = false;
             if (!existing.duration) {
                 existing.duration = await this.getMediaDuration(file);
                 changed = true;
             }
             if (!existing.size) {
                 existing.size = file.stat.size;
                 changed = true;
             }
             if (changed && shouldSave) await this.saveData();
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
        workspace.revealLeaf(leaf);
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
        workspace.revealLeaf(leaf);
        workspace.setActiveLeaf(leaf, { focus: true });
        
        // Ensure we get the view instance
        if (leaf.view instanceof CrossPlayerMainView) {
            this.mainView = leaf.view;
            // Force focus on the container element
            // We need a slight delay to ensure the view is fully active and DOM is ready
            setTimeout(() => {
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
        await this.activateMainView();
        
        // Update status of previous item if playing
        const currentPlaying = this.data.queue.find(i => i.status === 'playing');
        if (currentPlaying && currentPlaying.id !== item.id) {
            if (currentPlaying.finished) {
                currentPlaying.status = 'completed';
            } else {
                currentPlaying.status = 'pending';
            }
        }

        if (item.status === 'completed') {
            item.finished = true;
        }

        item.status = 'playing';
        await this.saveData();

        // Find the main view again just in case
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CROSS_PLAYER_MAIN);
        if (leaves.length > 0 && leaves[0].view instanceof CrossPlayerMainView) {
             leaves[0].view.play(item, autoPlay);
        }
    }
    
    async playNextUnread() {
        // Find the index of the last played item (which might be completed now)
        let currentIndex = -1;
        if (this.mainView && this.mainView.currentItem) {
             currentIndex = this.data.queue.findIndex(i => i.id === this.mainView!.currentItem!.id);
        }
        
        // If not found, fallback to searching from beginning
        if (currentIndex === -1) {
             // Try to find any playing item
             currentIndex = this.data.queue.findIndex(i => i.status === 'playing');
        }

        // Find next pending after currentIndex
        const nextItem = this.data.queue.find((item, index) => index > currentIndex && item.status === 'pending');
        
        if (nextItem) {
            this.playMedia(nextItem, true);
        }
    }

    async playNextItem() {
        let currentIndex = -1;
        if (this.mainView && this.mainView.currentItem) {
             currentIndex = this.data.queue.findIndex(i => i.id === this.mainView!.currentItem!.id);
        }
        
        const nextIndex = currentIndex + 1;
        if (nextIndex < this.data.queue.length) {
            this.playMedia(this.data.queue[nextIndex], true);
        }
    }

    async playPreviousItem() {
        let currentIndex = -1;
        if (this.mainView && this.mainView.currentItem) {
             currentIndex = this.data.queue.findIndex(i => i.id === this.mainView!.currentItem!.id);
        }
        
        if (currentIndex === -1) return;

        const prevIndex = currentIndex - 1;
        if (prevIndex >= 0) {
            this.playMedia(this.data.queue[prevIndex], true);
        }
    }

    async updateStatus(id: string, status: 'pending' | 'playing' | 'completed') {
        const item = this.data.queue.find(i => i.id === id);
        if (item) {
            item.status = status;
            if (status === 'completed') {
                item.finished = true;
            }
            await this.saveData();
        }
    }

    async updatePosition(id: string, position: number) {
        const item = this.data.queue.find(i => i.id === id);
        if (item) {
            item.position = position;
            await this.saveData();
        }
    }

    async moveItem(index: number, direction: number) {
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= this.data.queue.length) return;
        
        const item = this.data.queue[index];
        this.data.queue.splice(index, 1);
        this.data.queue.splice(newIndex, 0, item);
        await this.saveData();
    }

    async reorderItem(oldIndex: number, newIndex: number) {
        if (oldIndex < 0 || oldIndex >= this.data.queue.length || newIndex < 0 || newIndex >= this.data.queue.length) return;
        const item = this.data.queue[oldIndex];
        this.data.queue.splice(oldIndex, 1);
        this.data.queue.splice(newIndex, 0, item);
        await this.saveData();
    }

    async sortQueue(by: 'name' | 'type' | 'size', order: 'asc' | 'desc') {
        this.data.queue.sort((a, b) => {
            let valA: any = a.name;
            let valB: any = b.name;

            if (by === 'type') {
                valA = a.path.split('.').pop()?.toLowerCase() || '';
                valB = b.path.split('.').pop()?.toLowerCase() || '';
            } else if (by === 'size') {
                valA = a.size || 0;
                valB = b.size || 0;
            } else {
                 // name
                 valA = a.name.toLowerCase();
                 valB = b.name.toLowerCase();
            }

            if (valA < valB) return order === 'asc' ? -1 : 1;
            if (valA > valB) return order === 'asc' ? 1 : -1;
            return 0;
        });
        await this.saveData();
    }

    async cleanConsumedMedia() {
        const toRemove = this.data.queue.filter(item => item.status === 'completed');
        if (toRemove.length === 0) {
            new Notice("No completed media to clean.");
            return;
        }

        let count = 0;
        for (const item of toRemove) {
            try {
                const file = this.app.vault.getAbstractFileByPath(item.path);
                if (file instanceof TFile) {
                    await this.app.vault.trash(file, true);
                    count++;
                }
            } catch (e) {
                console.error("Failed to delete", item.path, e);
            }
        }

        this.data.queue = this.data.queue.filter(item => item.status !== 'completed');
        await this.saveData();
        new Notice(`Cleaned ${count} media files.`);
    }

    async deleteMediaItem(item: MediaItem) {
        // If it's the current playing item, stop playback
        const isCurrent = this.mainView && this.mainView.currentItem && this.mainView.currentItem.id === item.id;
        
        if (isCurrent && this.mainView) {
             this.mainView.videoEl.pause();
        }

        // Delete from vault
        try {
            const file = this.app.vault.getAbstractFileByPath(item.path);
            if (file instanceof TFile) {
                await this.app.vault.trash(file, true);
            }
        } catch (e) {
            console.error("Error deleting file:", e);
            new Notice("Error deleting file.");
        }

        // Remove from queue
        // Find next item if we are deleting the current one
        let nextItem: MediaItem | undefined;
        if (isCurrent) {
            const currentIndex = this.data.queue.findIndex(i => i.id === item.id);
            nextItem = this.data.queue.find((i, index) => index > currentIndex && i.status === 'pending');
        }

        this.data.queue = this.data.queue.filter(i => i.id !== item.id);
        await this.saveData();
        new Notice(`Deleted: ${item.name}`);

        if (isCurrent) {
            if (nextItem) {
                await this.playMedia(nextItem, true);
            } else {
                 if (this.mainView) {
                    this.mainView.currentItem = null;
                    this.mainView.videoEl.src = "";
                }
                this.activateListView();
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
        const isCurrent = this.mainView && this.mainView.currentItem && this.mainView.currentItem.id === item.id;

        // Update state
        item.status = 'pending';
        item.finished = false;
        item.position = 0;
        await this.saveData();
        
        if (isCurrent && this.mainView) {
             // Stop playback
            this.mainView.videoEl.pause();
            this.mainView.currentItem = null;
            this.mainView.videoEl.src = "";
            this.activateListView();
        }
        
        new Notice(`Marked as unread: ${item.name}`);
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
        const { youtubeDlpPath, downloadFolder, watchedFolder } = this.data.settings;
        const targetFolder = downloadFolder || watchedFolder;

        if (!targetFolder) {
            new Notice("Please set a download folder or watched folder first.");
            return;
        }

        // Resolve absolute path for the target folder
        const path = require('path');
        const fs = require('fs');
        
        // @ts-ignore
        const adapter = this.app.vault.adapter;
        let absolutePath: string;
        if (adapter instanceof Object && 'getBasePath' in adapter) {
             // @ts-ignore
             absolutePath = path.join(adapter.getBasePath(), targetFolder);
        } else {
             new Notice("Could not resolve absolute path for vault.");
             return;
        }

        if (!fs.existsSync(absolutePath)) {
            new Notice(`Target folder does not exist: ${targetFolder}`);
            return;
        }

        const ytPath = youtubeDlpPath.trim();
        if (ytPath !== 'yt-dlp' && !fs.existsSync(ytPath)) {
            new Notice(`yt-dlp binary not found at: ${ytPath}`);
            return;
        }

        new Notice(`Starting download of ${links.length} items...`);

        for (const link of links) {
            if (!link.trim()) continue;
            this.startDownload(link.trim(), quality, type, absolutePath);
        }
    }

    async startDownload(link: string, quality: string, type: 'video' | 'audio', cwd: string, existingId?: string) {
        if (!Platform.isDesktop) return;
        
        const { youtubeDlpPath, ffmpegPath } = this.data.settings;
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

        let args = [
            link,
            '-o', '%(title)s.%(ext)s',
            '--no-playlist',
            '--newline' 
        ];

        if (ffmpegPath) {
            args.push('--ffmpeg-location', ffmpegPath);
        }

        if (type === 'audio') {
            args.push('-x', '--audio-format', 'mp3');
        } else {
            if (quality === 'best') {
                args.push('-f', 'bestvideo+bestaudio/best');
            } else if (quality === '1080p') {
                 args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]');
            } else if (quality === '720p') {
                 args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]');
            } else if (quality === '480p') {
                 args.push('-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]');
            }
            args.push('--merge-output-format', 'mp4');
        }

        try {
            const { spawn } = require('child_process');
            console.log(`Spawning: ${ytPath} ${args.join(' ')}`);
            const child = spawn(ytPath, args, { cwd: cwd });
            downloadStatus.childProcess = child;

            child.stdout.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
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
                    if (line.includes('[download] Destination:')) {
                        const name = line.split('Destination:')[1].trim();
                        downloadStatus.name = name;
                        this.listView?.updateDownloadProgress();
                    }
                    // Conversion / Post-processing detection
                    if (line.includes('[ExtractAudio]') || line.includes('[ffmpeg]') || line.includes('[Merger]')) {
                         downloadStatus.status = 'converting';
                         downloadStatus.progress = '95%'; // Jump to 95% during conversion
                         this.listView?.updateDownloadProgress();
                    }
                }
            });

            child.stderr.on('data', (data: Buffer) => {
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
                    // Refresh watched folder
                    const { watchedFolder, downloadFolder } = this.data.settings;
                    const targetFolder = downloadFolder || watchedFolder;
                    if (targetFolder === watchedFolder) {
                        this.scanFolder(watchedFolder);
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
                    setTimeout(() => {
                        this.activeDownloads = this.activeDownloads.filter(d => d.id !== downloadId);
                        this.listView?.updateDownloadProgress();
                    }, 5000);
                }
            });

        } catch (e) {
            console.error("Download failed", e);
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

    resumeDownload(id: string) {
        if (!Platform.isDesktop) return;
        const path = require('path');

        const dl = this.activeDownloads.find(d => d.id === id);
        if (dl && dl.params) {
            const { downloadFolder, watchedFolder } = this.data.settings;
            const targetFolder = downloadFolder || watchedFolder;
            
            // Re-resolve path
            // @ts-ignore
            const adapter = this.app.vault.adapter;
            let absolutePath: string = "";
            if (adapter instanceof Object && 'getBasePath' in adapter) {
                 // @ts-ignore
                 absolutePath = path.join(adapter.getBasePath(), targetFolder);
            }

            if (absolutePath) {
                this.startDownload(dl.params.url, dl.params.quality, dl.params.type, absolutePath, id);
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
        this.quality = this.plugin.data.settings.defaultDownloadQuality;
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
            const videoArea = textareas[0] as HTMLTextAreaElement;
            videoArea.style.height = '100px';
            videoArea.style.width = '100%';
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
            (ta as HTMLTextAreaElement).style.height = '100px';
            (ta as HTMLTextAreaElement).style.width = '100%';
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
                        this.plugin.downloadVideos(videoList, this.quality, 'video');
                    }
                    
                    if (audioList.length > 0) {
                        this.plugin.downloadVideos(audioList, this.quality, 'audio');
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
        return this.app.vault.getAllLoadedFiles()
            .filter(f => f instanceof TFolder) as TFolder[];
    }

    getItemText(item: TFolder): string {
        return item.path;
    }

    onChooseItem(item: TFolder): void {
        this.plugin.setWatchedFolder(item.path);
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

        containerEl.createEl('h3', { text: 'General Settings' });

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
                        this.plugin.calculateDynamicLimit();
                    }
                }));

        new Setting(containerEl)
            .setName('Default Playback Speed')
            .setDesc('The default speed when the player starts or resets.')
            .addSlider(slider => slider
                .setLimits(0.5, 5.0, 0.1)
                .setValue(this.plugin.data.settings.defaultPlaybackSpeed)
                .setDynamicTooltip()
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

        containerEl.createEl('h3', { text: 'Storage & Download Settings' });

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
            .setName('Download Folder')
            .setDesc('Folder to save downloads (relative to vault). Leave empty to use Watched Folder.')
            .addText(text => text
                .setValue(this.plugin.data.settings.downloadFolder)
                .onChange(async (value) => {
                    this.plugin.data.settings.downloadFolder = value;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('Default Quality')
            .setDesc('Default quality selection.')
            .addDropdown(drop => drop
                .addOption('best', 'Best')
                .addOption('1080p', '1080p')
                .addOption('720p', '720p')
                .addOption('480p', '480p')
                .setValue(this.plugin.data.settings.defaultDownloadQuality)
                .onChange(async (value) => {
                    this.plugin.data.settings.defaultDownloadQuality = value as any;
                    await this.plugin.saveData();
                }));
    }
}

class CrossPlayerListView extends ItemView {
    plugin: CrossPlayerPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: CrossPlayerPlugin) {
        super(leaf);
        this.plugin = plugin;
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
        this.refresh();
    }

    refresh() {
        const container = this.contentEl;
        container.empty();
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.height = "100%";
        container.style.overflow = "hidden";
        
        // --- Header (Speed and Stats) ---
        const headerContainer = container.createDiv({ cls: "cross-player-header" });
        headerContainer.style.textAlign = "center";
        headerContainer.style.marginBottom = "10px";
        headerContainer.style.flexShrink = "0"; // Don't shrink

        // Title Row with Sort Button
        const titleRow = headerContainer.createDiv({ cls: "cross-player-title-row" });
        titleRow.style.display = "flex";
        titleRow.style.justifyContent = "center";
        titleRow.style.alignItems = "center";
        titleRow.style.gap = "8px";

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
        refreshBtn.onclick = async () => {
             await this.plugin.loadData();
             this.refresh();
             new Notice("Data reloaded.");
        };
        
        const speed = this.plugin.data.playbackSpeed || 1.0;
        const speedEl = headerContainer.createDiv({ cls: "cross-player-speed-display" });
        speedEl.setText(`Speed: ${speed.toFixed(1)}x`);
        speedEl.style.fontSize = "0.8em";
        speedEl.style.color = "var(--text-muted)";

        // Stats Display
        const stats = this.plugin.getQueueStats();
        const adjustedDuration = stats.totalDuration / speed;
        
        // Dynamic Limit
        const limitBytes = this.plugin.dynamicStorageLimit;
        const limitGB = limitBytes > 0 ? limitBytes / (1024 * 1024 * 1024) : 10; // Default 10GB if waiting
        const sizeInGB = stats.totalSize / (1024 * 1024 * 1024);

        const statsContainer = headerContainer.createDiv({ cls: "cross-player-stats" });
        statsContainer.style.fontSize = "0.8em";
        statsContainer.style.color = "var(--text-muted)";
        statsContainer.style.marginTop = "5px";
        
        const etcText = `ETC: ${this.formatDuration(adjustedDuration)}`;
        statsContainer.createSpan({ text: etcText });
        
        statsContainer.createSpan({ text: " • " });
        
        let limitText = `${limitGB.toFixed(1)} GB`;
        if (this.plugin.limitingDevice) {
            limitText += ` (${this.plugin.limitingDevice})`;
        }
        
        const sizeSpan = statsContainer.createSpan({ text: `Size: ${sizeInGB.toFixed(2)} GB / ${limitText}` });
        if (sizeInGB > limitGB) {
            sizeSpan.style.color = "var(--text-error)";
            sizeSpan.style.fontWeight = "bold";
        }

        // --- List (Scrollable) ---
        const list = container.createDiv({ cls: "cross-player-list" });
        list.style.flexGrow = "1";
        list.style.overflowY = "auto";
        list.style.overflowX = "hidden";
        // list.style.minHeight = "0"; // Firefox fix for flex overflow

        this.plugin.data.queue.forEach((item) => {
            const itemEl = list.createDiv({ cls: "cross-player-item" });
            itemEl.style.display = "flex";
            itemEl.style.alignItems = "center";
            itemEl.style.padding = "5px";
            itemEl.style.borderBottom = "1px solid var(--background-modifier-border)";
            
            if (item.status === 'playing') {
                itemEl.style.backgroundColor = "var(--background-modifier-active-hover)";
            }

            // Status Icon
            const statusIcon = itemEl.createDiv({ cls: "cross-player-status-icon" });
            if (item.status === 'completed') setIcon(statusIcon, "check-circle");
            else if (item.status === 'playing') setIcon(statusIcon, "play-circle");
            else setIcon(statusIcon, "circle");
            statusIcon.style.marginRight = "5px";

            // Type Icon
            if (this.plugin.data.settings.showMediaIndicator) {
                const typeIcon = itemEl.createDiv({ cls: "cross-player-type-icon" });
                const ext = item.path.split('.').pop()?.toLowerCase();
                const isAudio = ['mp3', 'wav', 'ogg'].includes(ext || '');
                setIcon(typeIcon, isAudio ? "headphones" : "film");
                typeIcon.style.marginRight = "10px";
                typeIcon.style.color = "var(--text-muted)";
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
            const nameEl = itemEl.createDiv({ text: item.name, cls: "cross-player-name" });
            nameEl.style.flexGrow = "1";
            nameEl.style.overflow = "hidden";
            nameEl.style.textOverflow = "ellipsis";
            nameEl.style.whiteSpace = "nowrap";
            nameEl.style.cursor = "pointer";
            nameEl.title = item.path;

            nameEl.onClickEvent(() => {
                // Prevent click if right-click (context menu) might have triggered this somehow, 
                // though usually contextmenu event is separate.
                // But specifically "does focus on the center player pane".
                
                // Always auto-play when user clicks
                this.plugin.playMedia(item, true);
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
                            this.plugin.deleteMediaItem(item);
                        })
                );

                menu.addItem((menuItem) =>
                    menuItem
                        .setTitle("Set as Unread")
                        .setIcon("undo")
                        .onClick(() => {
                            this.plugin.setMediaItemAsUnread(item);
                        })
                );

                menu.showAtPosition({ x: event.clientX, y: event.clientY });
            });

            // Controls
            const controls = itemEl.createDiv({ cls: "cross-player-controls" });
            controls.style.display = "flex";
            controls.style.gap = "5px";

            // Drag Handle
            const handle = controls.createDiv({ cls: "clickable-icon sortable-handle" });
            setIcon(handle, "grip-horizontal");
            handle.style.cursor = "grab";
        });

        Sortable.create(list, {
            animation: 150,
            handle: '.sortable-handle',
            ghostClass: 'sortable-ghost',
            onSort: async (evt) => {
                if (evt.oldIndex !== undefined && evt.newIndex !== undefined) {
                    // We don't want to trigger a full refresh immediately because Sortable has already moved the DOM element.
                    // But we DO want to save the new order.
                    // The issue is that saveData() calls refresh().
                    // We can optimize this by updating the data without calling refresh(), or just let it refresh.
                    // Let's just let it refresh for now to ensure consistency.
                    await this.plugin.reorderItem(evt.oldIndex, evt.newIndex);
                }
            }
        });

        // --- Download Area (Collapsible, Bottom) ---
        // Create container for download area
        const downloadContainer = container.createDiv({ cls: 'cross-player-download-container' });
        downloadContainer.style.flexShrink = "0";
        downloadContainer.style.borderTop = "1px solid var(--background-modifier-border)";
        downloadContainer.style.backgroundColor = "var(--background-secondary)";

        this.updateDownloadProgress(downloadContainer);
    }

    updateDownloadProgress(parentContainer?: HTMLElement) {
        // If parentContainer is provided, we are in initial render. 
        // If not, we need to find existing container.
        
        let container = parentContainer;
        if (!container) {
            container = this.contentEl.querySelector('.cross-player-download-container') as HTMLElement;
        }

        if (!container) return; // Should exist if view is open

        container.empty();

        const activeDownloads = this.plugin.activeDownloads;
        if (activeDownloads.length === 0) {
            // Collapsed or hidden state? 
            // If empty, maybe just hide content but keep header? 
            // Or hide completely? User said "collapsible towards the bottom". 
            // If no downloads, usually hidden.
            container.style.display = 'none';
            return;
        } else {
            container.style.display = 'block';
        }

        // Header / Toggle
        const header = container.createDiv({ cls: 'download-header' });
        header.style.padding = "5px 10px";
        header.style.cursor = "pointer";
        header.style.display = "flex";
        header.style.justifyContent = "space-between";
        header.style.alignItems = "center";
        header.style.backgroundColor = "var(--background-secondary-alt)";

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
        content.style.padding = "10px";
        content.style.maxHeight = "30vh";
        content.style.overflowY = "auto";
        if (isCollapsed) content.style.display = "none";

        header.onclick = () => {
            const collapsed = container!.dataset.collapsed === 'true';
            container!.dataset.collapsed = String(!collapsed);
            if (!collapsed) {
                content.style.display = "none";
                setIcon(toggleIcon, "chevron-up");
            } else {
                content.style.display = "block";
                setIcon(toggleIcon, "chevron-down");
            }
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
            globalBar.style.width = "100%";
            globalBar.style.height = "8px";
            globalBar.value = avgProgress;
            globalBar.max = 100;
        }

        activeDownloads.forEach(dl => {
            const dlItem = content.createDiv({ cls: 'download-item' });
            dlItem.style.marginBottom = "8px";
            dlItem.style.fontSize = "0.8em";
            dlItem.style.borderBottom = "1px solid var(--background-modifier-border)";
            dlItem.style.paddingBottom = "5px";
            
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
            progressBar.style.width = "100%";
            progressBar.style.height = "6px";
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
                 info.style.color = "var(--text-error)";
            }

            const btnGroup = controlsRow.createDiv({ attr: { style: "display: flex; gap: 5px;" } });
            
            // Pause/Resume Button
            if (dl.status === 'downloading') {
                const pauseBtn = btnGroup.createEl("button", { text: "Pause" });
                pauseBtn.style.fontSize = "0.8em";
                pauseBtn.style.padding = "2px 5px";
                pauseBtn.onclick = () => this.plugin.pauseDownload(dl.id);
            } else if (dl.status === 'paused') {
                const resumeBtn = btnGroup.createEl("button", { text: "Resume" });
                resumeBtn.style.fontSize = "0.8em";
                resumeBtn.style.padding = "2px 5px";
                resumeBtn.onclick = () => this.plugin.resumeDownload(dl.id);
            }

            // Cancel Button
            const cancelBtn = btnGroup.createEl("button", { text: "Cancel" });
            cancelBtn.style.fontSize = "0.8em";
            cancelBtn.style.padding = "2px 5px";
            cancelBtn.onclick = () => this.plugin.cancelDownload(dl.id);
        });
    }

    updateSpeedDisplay() {
        const speedEl = this.contentEl.querySelector(".cross-player-speed-display") as HTMLElement;
        if (speedEl) {
            const speed = this.plugin.data.playbackSpeed || 1.0;
            speedEl.setText(`Speed: ${speed.toFixed(1)}x`);
            this.refresh(); // Refresh to update stats based on new speed
        }
    }

    formatDuration(seconds: number): string {
        if (!seconds || isNaN(seconds)) return "0s";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}h ${m}m ${s}s`;
        return `${m}m ${s}s`;
    }
}

class CrossPlayerMainView extends ItemView {
    plugin: CrossPlayerPlugin;
    videoEl: HTMLVideoElement;
    overlayEl: HTMLElement | null = null;
    currentItem: MediaItem | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: CrossPlayerPlugin) {
        super(leaf);
        this.plugin = plugin;
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

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.justifyContent = "center";
        container.style.alignItems = "center";
        container.style.height = "100%";
        container.style.backgroundColor = "#000";
        container.style.position = "relative"; // Needed for overlay

        this.videoEl = container.createEl("video");
        this.videoEl.controls = true;
        this.videoEl.style.maxWidth = "100%";
        this.videoEl.style.maxHeight = "100%";
        this.videoEl.style.width = "100%";
        this.videoEl.style.height = "100%";

        this.refreshMobileOverlay();

        this.videoEl.onended = async () => {
            if (this.currentItem) {
                // If onended fires, it's definitely completed
                if (this.currentItem.status !== 'completed') {
                    await this.plugin.updateStatus(this.currentItem.id, 'completed');
                    this.plugin.playNextUnread();
                }
            }
        };

        this.videoEl.ontimeupdate = async () => {
             if (this.currentItem) {
                 this.currentItem.position = this.videoEl.currentTime;
                 
                 // Mark as completed if > 95% watched
                 // We don't want to auto-skip yet, just mark as completed so if user exits it's done.
                 // But wait, if we mark as completed, does it affect playback? No.
                 // But we should only do this once to avoid spamming save.
                 if (this.currentItem.status !== 'completed' && this.videoEl.duration > 0) {
                     const progress = this.videoEl.currentTime / this.videoEl.duration;
                     if (progress > 0.95) {
                         // Mark as completed silently?
                         // If we update status, it saves data.
                         await this.plugin.updateStatus(this.currentItem.id, 'completed');
                         // We do NOT trigger playNextUnread() here, we let the video finish naturally.
                         // Or user can skip.
                     }
                 }
             }
        };
        
        this.videoEl.onpause = async () => {
            if (this.currentItem) {
                await this.plugin.updatePosition(this.currentItem.id, this.videoEl.currentTime);
            }
        }
    }

    refreshMobileOverlay() {
        const container = this.contentEl;
        const shouldShow = Platform.isMobile;

        if (!shouldShow) {
            if (this.overlayEl) {
                this.overlayEl.remove();
                this.overlayEl = null;
            }
            return;
        }

        // If enabled, check if we need to create it
        if (!this.overlayEl || !container.contains(this.overlayEl)) {
            // Remove existing if it's detached but not null (shouldn't happen with correct logic, but safe)
            if (this.overlayEl) {
                this.overlayEl.remove();
            }
            this.createMobileOverlay(container);
        }
    }

    createMobileOverlay(container: HTMLElement) {
        // Overlay Container
        const overlay = container.createDiv({ cls: 'cross-player-overlay' });
        this.overlayEl = overlay;
        overlay.style.position = "absolute";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.width = "100%";
        overlay.style.height = "100%";
        overlay.style.display = "flex";
        overlay.style.flexDirection = "column";
        overlay.style.justifyContent = "center";
        overlay.style.alignItems = "center";
        overlay.style.backgroundColor = "rgba(0, 0, 0, 0.4)";
        overlay.style.zIndex = "10";
        overlay.style.opacity = "0";
        overlay.style.transition = "opacity 0.3s ease";
        overlay.style.pointerEvents = "none"; // Let clicks pass through when hidden

        // Visibility Logic
        let hideTimeout: NodeJS.Timeout;
        const showOverlay = () => {
            overlay.style.opacity = "1";
            overlay.style.pointerEvents = "auto";
            if (hideTimeout) clearTimeout(hideTimeout);
            hideTimeout = setTimeout(() => {
                overlay.style.opacity = "0";
                overlay.style.pointerEvents = "none";
            }, 3000); // Hide after 3 seconds
        };

        // Toggle on tap
        container.addEventListener('click', () => {
             // If clicking on a button, don't toggle immediately (buttons handle their own clicks)
             // But the overlay covers the video.
             // If hidden, show it.
             if (overlay.style.opacity === "0") {
                 showOverlay();
             } else {
                 // If visible and clicking background, maybe hide? 
                 // Or just let timeout handle it.
                 // Let's reset timeout.
                 showOverlay();
             }
        });

        // Controls Row
        const controlsRow = overlay.createDiv({ cls: 'cross-player-controls-row' });
        controlsRow.style.display = "flex";
        controlsRow.style.gap = "40px";
        controlsRow.style.alignItems = "center";

        // Previous Button
        const prevBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn' });
        setIcon(prevBtn, "skip-back");
        this.styleBigButton(prevBtn);
        prevBtn.onclick = (e) => {
            e.stopPropagation();
            this.plugin.playPreviousItem();
            showOverlay();
        };

        // Seek Back
        const seekBackBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn' });
        setIcon(seekBackBtn, "rewind");
        this.styleBigButton(seekBackBtn);
        seekBackBtn.onclick = (e) => {
            e.stopPropagation();
            this.seek(-this.plugin.data.settings.seekSecondsBackward);
            showOverlay();
        };

        // Play/Pause
        const playPauseBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn play-btn' });
        setIcon(playPauseBtn, "pause"); // Default to pause as we auto-play usually
        this.styleBigButton(playPauseBtn);
        playPauseBtn.style.transform = "scale(1.5)"; // Make it bigger
        
        playPauseBtn.onclick = (e) => {
            e.stopPropagation();
            if (this.videoEl.paused) {
                this.videoEl.play();
                setIcon(playPauseBtn, "pause");
            } else {
                this.videoEl.pause();
                setIcon(playPauseBtn, "play");
            }
            showOverlay();
        };

        // Update icon on state change
        this.videoEl.onplay = () => setIcon(playPauseBtn, "pause");
        this.videoEl.onpause = () => setIcon(playPauseBtn, "play");

        // Seek Forward
        const seekFwdBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn' });
        setIcon(seekFwdBtn, "fast-forward");
        this.styleBigButton(seekFwdBtn);
        seekFwdBtn.onclick = (e) => {
            e.stopPropagation();
            this.seek(this.plugin.data.settings.seekSecondsForward);
            showOverlay();
        };

        // Next Button
        const nextBtn = controlsRow.createDiv({ cls: 'cross-player-big-btn' });
        setIcon(nextBtn, "skip-forward");
        this.styleBigButton(nextBtn);
        nextBtn.onclick = (e) => {
            e.stopPropagation();
            this.plugin.playNextItem();
            showOverlay();
        };
    }

    styleBigButton(btn: HTMLElement) {
        btn.style.width = "50px";
        btn.style.height = "50px";
        btn.style.borderRadius = "50%";
        btn.style.backgroundColor = "rgba(0, 0, 0, 0.6)";
        btn.style.display = "flex";
        btn.style.justifyContent = "center";
        btn.style.alignItems = "center";
        btn.style.cursor = "pointer";
        btn.style.color = "white";
        // SVG size
        const svg = btn.querySelector('svg');
        if (svg) {
            svg.style.width = "24px";
            svg.style.height = "24px";
        }
    }

    async play(item: MediaItem, autoPlay: boolean = false) {
        this.currentItem = item;
        
        // Update view title
        // @ts-ignore
        if (this.leaf.view.headerTitleEl) {
             // @ts-ignore
             this.leaf.view.headerTitleEl.setText(item.name);
        } else {
             // Fallback or if titleEl is the one used in older/newer API
             // @ts-ignore
             if (this.leaf.view.titleEl) this.leaf.view.titleEl.setText(item.name);
        }
        
        if (!this.videoEl) {
             // Re-create if missing (unlikely if view is open)
             const container = this.contentEl;
             this.videoEl = container.createEl("video");
             this.videoEl.controls = true;
             this.videoEl.style.maxWidth = "100%";
             this.videoEl.style.maxHeight = "100%";
             this.videoEl.style.width = "100%";
             this.videoEl.style.height = "100%";
        }
        
        const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
        if (file instanceof TFile) {
             this.videoEl.src = this.plugin.app.vault.getResourcePath(file);
        } else {
             console.error("File not found for playback:", item.path);
             return;
        }

        this.videoEl.currentTime = item.position || 0;
        this.videoEl.playbackRate = this.plugin.data.playbackSpeed || 1.0;
        
        if (autoPlay) {
            try {
                await this.videoEl.play();
            } catch (e) {
                console.error("Autoplay failed", e);
            }
        }
    }

    async changePlaybackSpeed(delta: number) {
        if (!this.videoEl) return;
        const newSpeed = Math.max(0.1, this.videoEl.playbackRate + delta);
        this.videoEl.playbackRate = newSpeed;
        
        // Update persistent data
        this.plugin.data.playbackSpeed = newSpeed;
        await this.plugin.saveData();

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

        if (!document.fullscreenElement) {
            this.contentEl.requestFullscreen().catch(err => {
                new Notice(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
            });
        } else {
            document.exitFullscreen();
        }
    }
}
