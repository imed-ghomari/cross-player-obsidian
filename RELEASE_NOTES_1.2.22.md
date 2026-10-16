# Cross Player 1.2.22

This patch release fixes playback progress being reset after adding new files externally (e.g. Android downloads) and restarting Obsidian.

Highlights:
- Playback merge before save is now strictly last-writer-wins by `playbackUpdatedAt`: a stale `data.json` copy can no longer clobber newer local progress for already-saved, non-playing files.
- Genuinely newer progress from another device still syncs, and the actively playing file is still never yanked mid-playback.
