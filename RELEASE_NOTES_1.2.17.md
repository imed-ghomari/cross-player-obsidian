# Cross Player 1.2.17

This patch release makes cross-device sync seamless for queue position and file deletion.

Highlights:
- Deleted media is now always permanently removed from disk, bypassing Obsidian trash and system trash settings so cleaned files cannot come back.
- Fixed cleaned or deleted files reappearing when another device syncs late.
- Fixed queue reorders and deletes being wiped by background sync reloads.
- Fixed playback progress handling so small updates retry promptly instead of waiting a full cycle, reducing lost progress on abrupt Android close.
- Fixed playback position jumping mid-play when another device saves a newer timestamp for the same file.
