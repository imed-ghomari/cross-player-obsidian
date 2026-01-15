import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, setIcon, Notice, TFolder, TFile, FuzzySuggestModal, TAbstractFile, Menu, Modal } from 'obsidian';
import { MediaItem, CrossPlayerData, CrossPlayerSettings, DownloadStatus } from './types';
import Sortable from 'sortablejs';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const VIEW_TYPE_CROSS_PLAYER_LIST = "cross-player-list-view";
const VIEW_TYPE_CROSS_PLAYER_MAIN = "cross-player-main-view";

const DEFAULT_SETTINGS: CrossPlayerSettings = {
    watchedFolder: '',
    defaultPlaybackSpeed: 2.0,
    seekSecondsForward: 10,
    seekSecondsBackward: 10,
    youtubeDlpPath: 'yt-dlp',
    downloadFolder: '',
    defaultDownloadQuality: 'best',
    defaultDownloadType: 'video',
    maxStorageLimit: 10, // GB
    showMediaIndicator: true
}

export default class CrossPlayerPlugin extends Plugin {
    data: CrossPlayerData;
    // No more fs watcher, we use Obsidian events
    listView: CrossPlayerListView | null = null;
    mainView: CrossPlayerMainView | null = null;
    activeDownloads: DownloadStatus[] = [];

    async onload() {
        await this.loadData();

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

        this.registerWatchers();

        if (this.data.settings.watchedFolder) {
            this.scanFolder(this.data.settings.watchedFolder);
        }
    }

    onunload() {
        // Events are automatically cleaned up by Obsidian on plugin unload if registered correctly
        // but we used `app.vault.on` so we might need to handle it if we want to be super clean,
        // but usually Plugin class handles event refs if we use `this.registerEvent`.
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
            // We can iterate children directly
            // Or use getFiles() and filter
            const files = this.app.vault.getFiles();
            files.forEach(file => {
                // Check if file is inside the watched folder
                if (file.path.startsWith(folderPath + "/")) {
                     this.handleFileChange(file);
                }
            });
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

    async handleFileChange(file: TAbstractFile) {
        const folderPath = this.data.settings.watchedFolder;
        if (!folderPath) return;

        // Recursively handle folders
        if (file instanceof TFolder) {
            for (const child of file.children) {
                await this.handleFileChange(child);
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
                id: Math.random().toString(36).substr(2, 9),
                path: file.path, // Store vault relative path
                name: file.name,
                status: 'pending',
                position: 0,
                duration: duration,
                size: file.stat.size
            };
            this.data.queue.push(newItem);
            await this.saveData();
            new Notice(`Added ${file.name} to queue`);
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
             if (changed) await this.saveData();
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
        // Ensure we get the view instance
        if (leaf.view instanceof CrossPlayerMainView) {
            this.mainView = leaf.view;
        }
    }

    async playMedia(item: MediaItem, autoPlay: boolean = false) {
        await this.activateMainView();
        
        // Update status of previous item if playing
        const currentPlaying = this.data.queue.find(i => i.status === 'playing');
        if (currentPlaying && currentPlaying.id !== item.id) {
            currentPlaying.status = 'pending'; 
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
        const { youtubeDlpPath, downloadFolder, watchedFolder } = this.data.settings;
        const targetFolder = downloadFolder || watchedFolder;

        if (!targetFolder) {
            new Notice("Please set a download folder or watched folder first.");
            return;
        }

        // Resolve absolute path for the target folder
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

        new Notice(`Starting download of ${links.length} items...`);

        for (const link of links) {
            if (!link.trim()) continue;

            const downloadId = Math.random().toString(36).substring(7);
            const downloadStatus: DownloadStatus = {
                id: downloadId,
                name: link, // Initial name, update later if possible
                progress: '0%',
                speed: '0',
                eta: '?',
                status: 'downloading'
            };
            this.activeDownloads.push(downloadStatus);
            this.listView?.updateDownloadProgress();

            let args = [
                link.trim(),
                '-o', '%(title)s.%(ext)s',
                '--no-playlist',
                '--newline' // Important for parsing output line by line
            ];

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
                await new Promise<void>((resolve, reject) => {
                    console.log(`Spawning: ${youtubeDlpPath} ${args.join(' ')}`);
                    const child = spawn(youtubeDlpPath, args, { cwd: absolutePath });

                    child.stdout.on('data', (data) => {
                        const lines = data.toString().split('\n');
                        for (const line of lines) {
                            // [download]  23.5% of 10.00MiB at  2.00MiB/s ETA 00:05
                            if (line.includes('[download]')) {
                                const percentMatch = line.match(/(\d+\.\d+)%/);
                                const speedMatch = line.match(/at\s+([^\s]+)/);
                                const etaMatch = line.match(/ETA\s+([^\s]+)/);
                                
                                if (percentMatch) {
                                    downloadStatus.progress = percentMatch[1] + '%';
                                }
                                if (speedMatch) {
                                    downloadStatus.speed = speedMatch[1];
                                }
                                if (etaMatch) {
                                    downloadStatus.eta = etaMatch[1];
                                }
                                this.listView?.updateDownloadProgress();
                            }
                            // [download] Destination: Video Title.mp4
                            if (line.includes('[download] Destination:')) {
                                const name = line.split('Destination:')[1].trim();
                                downloadStatus.name = name;
                                this.listView?.updateDownloadProgress();
                            }
                        }
                    });

                    child.stderr.on('data', (data) => {
                        console.error(`yt-dlp stderr: ${data}`);
                    });

                    child.on('close', (code) => {
                        if (code === 0) {
                            downloadStatus.status = 'completed';
                            downloadStatus.progress = '100%';
                            resolve();
                        } else {
                            downloadStatus.status = 'error';
                            downloadStatus.error = `Exit code ${code}`;
                            reject(new Error(`yt-dlp exited with code ${code}`));
                        }
                        this.listView?.updateDownloadProgress();
                    });
                });
                
                // Remove from active downloads after a short delay
                setTimeout(() => {
                    this.activeDownloads = this.activeDownloads.filter(d => d.id !== downloadId);
                    this.listView?.updateDownloadProgress();
                }, 5000);

            } catch (e) {
                console.error("Download failed", e);
                new Notice(`Failed to download: ${link}`);
                downloadStatus.status = 'error';
                downloadStatus.error = 'Failed';
                this.listView?.updateDownloadProgress();
            }
        }
        
        // Refresh watched folder
        if (targetFolder === watchedFolder) {
            this.scanFolder(watchedFolder);
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

    onChooseItem(item: TFolder, evt: MouseEvent | KeyboardEvent): void {
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

        new Setting(containerEl)
            .setName('Default Type')
            .setDesc('Default download type.')
            .addDropdown(drop => drop
                .addOption('video', 'Video')
                .addOption('audio', 'Audio')
                .setValue(this.plugin.data.settings.defaultDownloadType)
                .onChange(async (value) => {
                    this.plugin.data.settings.defaultDownloadType = value as any;
                    await this.plugin.saveData();
                }));

        new Setting(containerEl)
            .setName('Max Storage Limit (GB)')
            .setDesc('Maximum storage size for watched folder before warning.')
            .addText(text => text
                .setValue(String(this.plugin.data.settings.maxStorageLimit || 10))
                .onChange(async (value) => {
                    const parsed = parseFloat(value);
                    if (!isNaN(parsed) && parsed > 0) {
                        this.plugin.data.settings.maxStorageLimit = parsed;
                        await this.plugin.saveData();
                    }
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
        
        // Header with Speed and Stats
        const headerContainer = container.createDiv({ cls: "cross-player-header" });
        headerContainer.style.textAlign = "center";
        headerContainer.style.marginBottom = "10px";

        headerContainer.createEl("h4", { text: "Media Queue", cls: "cross-player-title" });
        
        const speed = this.plugin.data.playbackSpeed || 1.0;
        const speedEl = headerContainer.createDiv({ cls: "cross-player-speed-display" });
        speedEl.setText(`Speed: ${speed.toFixed(1)}x`);
        speedEl.style.fontSize = "0.8em";
        speedEl.style.color = "var(--text-muted)";

        // Stats Display
        const stats = this.plugin.getQueueStats();
        const adjustedDuration = stats.totalDuration / speed;
        const maxStorage = this.plugin.data.settings.maxStorageLimit || 10;
        const sizeInGB = stats.totalSize / (1024 * 1024 * 1024);

        const statsContainer = headerContainer.createDiv({ cls: "cross-player-stats" });
        statsContainer.style.fontSize = "0.8em";
        statsContainer.style.color = "var(--text-muted)";
        statsContainer.style.marginTop = "5px";
        
        const etcText = `ETC: ${this.formatDuration(adjustedDuration)}`;
        statsContainer.createSpan({ text: etcText });
        
        statsContainer.createSpan({ text: " • " });
        
        const sizeSpan = statsContainer.createSpan({ text: `Size: ${sizeInGB.toFixed(2)} GB / ${maxStorage} GB` });
        if (sizeInGB > maxStorage) {
            sizeSpan.style.color = "var(--text-error)";
            sizeSpan.style.fontWeight = "bold";
        }

        const list = container.createDiv({ cls: "cross-player-list" });

        this.plugin.data.queue.forEach((item, index) => {
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
                // Auto-play if item has progress (resuming), otherwise pause (new)
                const shouldAutoPlay = item.position > 0;
                this.plugin.playMedia(item, shouldAutoPlay);
            });

            // Context Menu
            itemEl.addEventListener("contextmenu", (event) => {
                event.preventDefault();
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

        this.updateDownloadProgress();
    }
    updateDownloadProgress() {
        const container = this.contentEl;
        let progressArea = container.querySelector('.cross-player-download-area') as HTMLElement;
        
        const activeDownloads = this.plugin.activeDownloads;

        if (activeDownloads.length === 0) {
            if (progressArea) progressArea.remove();
            return;
        }

        if (!progressArea) {
            progressArea = container.createDiv({ cls: 'cross-player-download-area' });
            progressArea.style.borderTop = "1px solid var(--background-modifier-border)";
            progressArea.style.padding = "10px";
            progressArea.style.marginTop = "auto"; // Push to bottom if flex container
            progressArea.style.backgroundColor = "var(--background-secondary)";
        } else {
            progressArea.empty();
        }

        const title = progressArea.createEl("h5", { text: "Active Downloads" });
        title.style.margin = "0 0 5px 0";

        activeDownloads.forEach(dl => {
            const dlItem = progressArea!.createDiv({ cls: 'download-item' });
            dlItem.style.marginBottom = "5px";
            dlItem.style.fontSize = "0.8em";
            
            const titleRow = dlItem.createDiv({ attr: { style: "display: flex; justify-content: space-between;" } });
            titleRow.createSpan({ text: dl.name, attr: { style: "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%;" } });
            titleRow.createSpan({ text: dl.status === 'error' ? 'Error' : dl.progress });

            if (dl.status === 'downloading') {
                const detailsRow = dlItem.createDiv({ attr: { style: "color: var(--text-muted); font-size: 0.9em;" } });
                detailsRow.setText(`${dl.speed} - ETA: ${dl.eta}`);
            } else if (dl.status === 'error') {
                 dlItem.createDiv({ text: dl.error, attr: { style: "color: var(--text-error);" } });
            }
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

        this.videoEl = container.createEl("video");
        this.videoEl.controls = true;
        this.videoEl.style.maxWidth = "100%";
        this.videoEl.style.maxHeight = "100%";
        this.videoEl.style.width = "100%";
        this.videoEl.style.height = "100%";

        this.videoEl.onended = async () => {
            if (this.currentItem) {
                await this.plugin.updateStatus(this.currentItem.id, 'completed');
                this.plugin.playNextUnread();
            }
        };

        this.videoEl.ontimeupdate = () => {
             if (this.currentItem) {
                 this.currentItem.position = this.videoEl.currentTime;
             }
        };
        
        this.videoEl.onpause = async () => {
            if (this.currentItem) {
                await this.plugin.updatePosition(this.currentItem.id, this.videoEl.currentTime);
            }
        }
    }

    async play(item: MediaItem, autoPlay: boolean = false) {
        this.currentItem = item;
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
}
