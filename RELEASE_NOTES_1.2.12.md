# Cross Player 1.2.12

This patch release smooths out queue updates during Android playback and includes the latest queue state persistence fix.

Highlights:
- Fixed an Android playback hitch that could happen when a newly created media file was added to the queue while another file was already playing.
- Deferred expensive duration probing for newly detected Android media until playback is idle, while still adding the item to the queue immediately.
- Includes the latest save-order fix so queue updates do not overwrite newer playback positions.
