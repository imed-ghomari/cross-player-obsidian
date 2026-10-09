# Cross Player 1.2.21

This patch release fixes playback progress being lost when a second device adds a file before receiving the latest sync.

Highlights:
- Reloads no longer discard newer in-memory playback when `data.json` reverts to a stale copy (e.g. Resilio Sync offline-wins). Newer `playbackUpdatedAt` is restored and re-saved.
- Folder scans reload from disk first, so a download/new file no longer forks over another device's fresh progress.
- Delayed the first startup scan to give Resilio Sync time to deliver an updated `data.json` before bumping `queueUpdatedAt`.
