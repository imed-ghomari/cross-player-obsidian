# Cross Player 1.2.6

This patch release fixes queue state persistence during common actions and cleans up the player reset flow when removing media.

Highlights:
- Preserved the queue scroll position when jumping to the next media item.
- Preserved the queue scroll position when using queue secondary actions like `Set as Unread`.
- Fixed cleaning consumed media so deleting the currently loaded file no longer shows a false playback error or leaves the stale blank player screen behind.
- Styled file extensions in the media queue with a more muted Obsidian text color to better distinguish them from the media title.
