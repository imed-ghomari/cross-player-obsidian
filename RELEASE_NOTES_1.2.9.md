# Cross Player 1.2.9

This patch release reduces the plugin's disclosure surface for community review.

Highlights:
- Replaced vault-wide enumeration helpers with watched-folder traversal.
- Reworked folder discovery to avoid `vault.getFiles()` and `getAllLoadedFiles()`.
- Keeps the previous cross-device playback messaging and lint cleanup intact.
