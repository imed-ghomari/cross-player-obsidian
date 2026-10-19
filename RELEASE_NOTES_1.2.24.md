# Cross Player 1.2.24

This patch release makes the left/right arrow keys follow the Seek Forward/Backward settings, and removes the now redundant Seek Forward/Backward commands.

Highlights:
- Left/right arrow keys now jump by the configured Seek Forward and Seek Backward seconds. The duration-based jumping introduced in 1.2.23 has been reverted.
- The Seek Forward and Seek Backward commands have been removed from the command palette, since the arrow keys replace them.
- The on-screen seek buttons and the arrow keys share the same intervals, so seeking behaves consistently everywhere.
- You can change the jump size any time in Settings > Cross Player > Seek Forward/Backward Seconds.
