# Cross Player 1.2.13

This patch release fixes Android-to-desktop playback sync so desktop startup scans do not reset newer mobile progress.

Highlights:
- Added playback update timestamps so fresher synced positions and completion states are preserved before saving.
- Prevented watched-folder scans from rewriting `data.json` when no queue metadata actually changed.
- Kept startup scans able to add new media and fill missing duration/size metadata without clobbering newer Android playback progress.
