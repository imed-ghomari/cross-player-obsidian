# Cross Player 1.2.14

This patch release republishes the Android-to-desktop playback sync fix with corrected plugin release metadata.

Highlights:
- Preserves newer Android playback positions when desktop opens and scans the watched folder.
- Avoids rewriting synced playback data when a desktop scan finds no queue changes.
- Updates the release script so `manifest.json` is bumped alongside `package.json` in future releases.
