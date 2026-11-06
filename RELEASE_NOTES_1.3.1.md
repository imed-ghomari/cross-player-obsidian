# Cross Player 1.3.1

This release makes cross-device syncing more reliable, keeps deleted media deleted, and fixes YouTube downloads with current versions of yt-dlp.

## Deleted media stays deleted

- Deleting a file from the queue — including **Delete Current File** and **Clean Consumed Media** — now tells every device that the file was intentionally removed.
- If Resilio Sync (or another sync tool) restores an older copy a moment later, Cross Player removes it again instead of putting it back in the queue.
- The same protection applies on the other devices, so an old copy left on an offline device can no longer keep bringing the file back.
- A genuinely new file at the same path is still recognized after the short sync-protection window, so re-downloading or re-importing a title works normally.

## More reliable cross-device state

- Each device now keeps its own queue and playback state file inside the plugin's `state` folder. Sync tools no longer have to merge two devices writing the same file.
- Queue order, playback progress, completed items, and deletions keep flowing between desktop and mobile as before.
- The first time a device runs this version, its existing queue and progress are migrated automatically.

## YouTube downloading fixed

- Removed the forced `android_vr` YouTube player client. That client now requires a GVS PO Token, which made yt-dlp skip its formats and fail every download with **HTTP Error 403: Forbidden**.
- Cross Player now lets yt-dlp use its normal player-client rotation.
- Verified with **yt-dlp 2026.10.26** and **ffmpeg 9.0.2**: an audio download produces a real `.mp3`, and a video download produces one merged `.mp4` with no leftover format files.

## Download requirements

- **yt-dlp and ffmpeg are both mandatory** for YouTube downloads.
- ffmpeg is needed for every MP3 conversion and for merging video and audio into a single MP4.
- Both programs must be on your `PATH`, or you can set their full paths in **Settings > Cross Player**.
- On macOS, Cross Player automatically adds `/usr/local/bin` and `/opt/homebrew/bin` to the `PATH` it uses.
