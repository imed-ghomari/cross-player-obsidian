# Cross Player 1.2.5

This patch release improves cross-device syncing for playback progress and fixes a pane-close regression that could reset the saved position back to the beginning.

Highlights:
- Improved synced `data.json` reload detection so playback position updates propagate more reliably to other devices.
- Added refresh checks on focus, app visibility return, and a periodic sync poll to keep queue progress current across devices.
- Updated the active player to reconcile synced queue positions when this device is not actively playing the file.
- Fixed closing the player pane from the middle of a file so the saved position no longer resets to the beginning.
