# Cross Player 1.2.2

This patch release fixes media deletion so cleanup actually frees disk space instead of routing files into Obsidian's local `.trash` folder.

Highlights:
- Fixed manual queue deletion to permanently remove media files from disk instead of sending them to Obsidian local trash.
- Fixed `Clean Consumed Media` to permanently delete completed files from disk so watched devices do not keep filling up.
- Updated the cleanup confirmation copy and deletion notice to reflect the new permanent-delete behavior.
