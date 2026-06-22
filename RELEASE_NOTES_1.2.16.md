# Cross Player 1.2.16

This patch release fixes two bugs introduced or discovered during recent development.

Highlights:
- Fixed playback progress not being saved when Obsidian is force-closed on Android. Progress is now persisted to disk every 5 seconds during playback, so at most 5 seconds of progress can be lost on abrupt close.
- Fixed ESLint warning (`@typescript-eslint/no-unsafe-assignment`) on `saveData` promise chain by replacing `catch(() => undefined)` with properly typed `catch(() => {})` calls.
