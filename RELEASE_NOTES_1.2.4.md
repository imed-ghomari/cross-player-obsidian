# Cross Player 1.2.4

This patch release fixes playback progress persistence and queue progress updates for audio files with unstable browser-reported durations, especially mp3.

Highlights:
- Fixed saved playback position updates so they persist during playback instead of only when switching files.
- Fixed queue progress bar updates for mp3 playback.
- Preserved the current playback position when closing the player pane.
- Hardened progress and completion tracking for other media formats that can report duration changes after loading.
