### Release 1.0.1

- Improved playback handling with new stop() method to properly reset video state.
- Enhanced media position tracking with force parameter.
- Fixed UI rendering with progress bar improvements (changed from background gradient to separate progress element).
- Added scroll position persistence for the queue list.
- Improved download title detection with multiple parsing strategies.
- Context rewind feature: automatically resume 2 seconds before last position.
- Better handling of duration mismatches during source transitions.