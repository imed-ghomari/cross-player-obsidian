# Cross Player for Obsidian

A powerful media player plugin for Obsidian that transforms a local folder into a managed playback queue. Designed for efficient learning and media consumption, it supports video and audio files with advanced playback controls, YouTube downloading, and storage management.

## Features

### 📺 Media Playback
- **Universal Player**: Supports a wide range of formats.
  - **Audio**: mp3, wav, ogg, m4a, flac, aac.
  - **Video**: mp4, webm, ogv, mkv, 3gp.
- **Enhanced Audio Experience**: Audio files feature a dedicated placeholder with a music icon and file name, keeping the interface clean and informative.
- **Smart Resume**: Automatically resumes where you left off. New files start paused; in-progress files auto-play.
- **Auto-play Next**: Automatically plays the next unread item in the queue when the current one finishes (configurable).
- **Variable Speed**: Adjustable playback speed (default 2x) with persistence per session.
- **Subtitle Support**: 
  - Supports sidecar `.vtt` and `.srt` files (must have the same name as the media file).
  - Automatically detects and enables embedded subtitle tracks.
  - *Note: MKV embedded subtitles (PGS/ASS) may have limited native browser support.*
- **Seek Controls**: Customizable forward/backward seek intervals.

### 📱 Mobile Experience
- **Unified Touch Overlay**: Large, touch-friendly controls for both Audio and Video files.
- **Smart Gestures**:
  - **Tap Video**: Pauses playback and reveals the control overlay.
  - **Tap Background**: Hides the overlay immediately.
  - **Safety Zone**: The bottom 50px allows interaction with native scrubbing and fullscreen controls.
- **Theme Adaptive**: Overlay buttons automatically switch between Light and Dark modes to match your system/app theme.
- **Conflict Free**: Native play buttons are hidden on mobile to prevent accidental double-triggering and visual clutter.

### 📋 Queue Management
- **Watched Folder**: Automatically monitors a specific folder (and subfolders) for new media.
- **Progress Tracking**: 
  - Visual indicators for completed, playing, and pending items.
  - **Progress Background**: Optional setting to show playback progress as a subtle background color in the queue list.
- **Sort Queue**: Sort by Name, Type, or Size (Ascending/Descending).
- **Drag & Drop**: Reorder your queue manually to prioritize content. Optimized for mobile touch dragging.
- **Visual Indicators**: Distinct icons for audio (headphones) and video (film) files (toggleable in settings).
- **ETC & Storage**: Displays "Estimated Time to Complete" based on current playback speed and warns when storage limits are exceeded.

### ⬇️ YouTube Integration
- **Built-in Downloader**: Download videos or audio directly from YouTube using `yt-dlp`.
- **Batch Processing**: Paste multiple links (one per line) to queue several downloads at once.
- **Quality Options**: Choose between Video (Best, 1080p, 720p, 480p) or Audio-only (mp3).
- **Collapsible Progress**: Monitor active downloads in a dedicated, collapsible section at the bottom of the queue.

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
   - Files from your watched folder appear automatically.
3. **Playback**:
   - Click an item to play it in the main view.
   - Use the player controls or commands to seek and change speed.
   - On mobile, tap the video area to pause and show large overlay controls.

## Commands

- `Open Cross Player`: Opens the queue view.
- `Download YouTube Video`: Opens the modal to paste YouTube links.
- `Clean Consumed Media`: Deletes all files marked as "completed".
- `Reload Data from Disk`: Manually re-loads data and scans the folder for new files.
- `Set Watched Folder`: Picker to select a folder via UI.
- `Increase/Decrease Playback Speed`: Adjust speed by 0.1x steps.
- `Seek Forward/Backward`: Jump by configured seconds.
- `Go to Next/Previous File`: Skip through your queue.
- `Delete Current File`: Delete the currently playing file immediately.
- `Set Current File as Unread`: Reset status to pending.
- `Toggle Fullscreen`: Enter or exit fullscreen mode.
- `Toggle Subtitles`: Enable/disable subtitle tracks.
- `Switch Subtitle Track`: Cycle through available subtitle tracks.
- `Test yt-dlp Configuration`: Verify that `yt-dlp` is correctly installed and accessible (Desktop only).

## Settings

### General Settings
- **Watched Folder**: The absolute path to your media folder.
- **Default Playback Speed**: Speed to start new files at.
- **Auto-play Next**: Toggle automatic playback of the next unread item.
- **Seek Intervals**: Custom seconds for forward/back.
- **Show Media Indicator**: Toggle audio/video icons in the queue.
- **Show Progress Color**: Toggle the background progress bar in the queue list.

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
