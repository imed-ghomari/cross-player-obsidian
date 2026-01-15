# Cross Player for Obsidian

A powerful media player plugin for Obsidian that transforms a local folder into a managed playback queue. Designed for efficient learning and media consumption, it supports video and audio files with advanced playback controls, YouTube downloading, and storage management.

## Features

### 📺 Media Playback
- **Universal Player**: Supports standard audio and video formats.
- **Smart Resume**: Automatically resumes where you left off. New files start paused; in-progress files auto-play.
- **Variable Speed**: Adjustable playback speed (default 2x) with persistence per session.
- **Mobile Overlay**: Touch-friendly overlay controls for mobile devices with large buttons for play/pause, seek, and navigation.
- **Seek Controls**: Customizable forward/backward seek intervals.

### 📋 Queue Management
- **Watched Folder**: Automatically monitors a specific folder for new media.
- **Recursive Scanning**: Detects files in subfolders of the watched directory.
- **Drag & Drop**: Reorder your queue manually to prioritize content.
- **Visual Indicators**: Icons distinguish between audio and video files (toggleable in settings).
- **ETC & Storage**: Displays "Estimated Time to Complete" based on current playback speed and warns when storage limits are exceeded.

### ⬇️ YouTube Integration
- **Built-in Downloader**: Download videos or audio directly from YouTube using `yt-dlp`.
- **Quality Options**: Choose between Video (Best, 1080p, 720p, 480p) or Audio-only.
- **Progress Tracking**: Real-time download progress displayed directly in the queue view.

### 🧹 Maintenance
- **Clean Consumed**: One-click command to delete all completed files from disk to free up space.
- **Storage Limits**: Set a maximum storage limit (GB) to get visual warnings when your queue gets too big.

## Usage

1. **Setup**:
   - Go to **Settings > Cross Player**.
   - Set your **Watched Folder** (absolute path).
   - (Optional) Configure `yt-dlp` path if you want to use the downloader.
2. **Queue**:
   - Open "Cross Player" from the ribbon icon or command palette.
   - Files from your watched folder (and subfolders) appear automatically.
3. **Playback**:
   - Click an item to play it in the main view.
   - Use the player controls or commands to seek and change speed.
   - On mobile, tap the video to show large overlay controls.

## Commands

- `Open Cross Player`: Opens the queue view.
- `Download YouTube Video`: Opens the modal to paste a YouTube link.
- `Clean Consumed Media`: Deletes all files marked as "completed".
- `Refresh Watched Folder`: Manually re-scans the folder for new files.
- `Set Watched Folder`: Picker to select a folder via UI.
- `Increase/Decrease Playback Speed`: Adjust speed by 0.1x steps.
- `Seek Forward/Backward`: Jump by configured seconds.
- `Go to Next/Previous File`: Skip through your queue.
- `Delete Current File`: Delete the currently playing file immediately.
- `Set Current File as Unread`: Reset status to pending.

## Settings

### General Settings
- **Watched Folder**: The absolute path to your media folder.
- **Default Playback Speed**: Speed to start new files at.
- **Seek Intervals**: Custom seconds for forward/back.
- **Show Media Indicator**: Toggle audio/video icons in the queue.
- **Enable Mobile Overlay**: Toggle touch controls for video (enabled by default on mobile).

### Storage & Download Settings
- **yt-dlp Path**: Path to the `yt-dlp` executable.
- **Download Folder**: Where to save YouTube downloads (defaults to watched folder).
- **Default Quality/Type**: Set your preferred download format.
- **Storage Limit**: Warning threshold in GB.

## Requirements
- **Obsidian**: Latest version recommended.
- **yt-dlp**: Required only for YouTube downloading features. Ensure it is installed and accessible in your path or specified in settings.

---
*Created for personal productivity and media consumption.*
