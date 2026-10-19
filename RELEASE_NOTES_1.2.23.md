# Cross Player 1.2.23

This patch release fixes left/right arrow key seeking in the player and makes the jump size adapt to the length of the media.

Highlights:
- Left/right arrow keys now seek reliably, including right after opening a file, when the player controls hold focus.
- The arrow keys now jump by about 5% of the media length (minimum 5 seconds, maximum 30 seconds) instead of the fixed Seek Forward/Backward interval. Short clips move in small steps; long videos move in bigger ones.
- The Seek Forward/Backward setting is unchanged and still applies to the Seek Forward/Backward commands and the on-screen seek buttons.
- Pressing the arrow keys before a file has finished loading no longer causes an error.
