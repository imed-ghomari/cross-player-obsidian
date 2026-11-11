# Cross Player 1.3.3

Two small but noticeable fixes: downloads now show the name of the media instead of a raw file path, and tapping the video on mobile pauses **and** resumes playback.

## Download names you can actually read

- While a download runs, the download panel used to show the full path yt-dlp printed — with the file extension cut off — which made two downloads nearly impossible to tell apart.
- Each download now shows the media file name, for example `How_to_build_a_cabin.mp4`, as soon as yt-dlp reports it, and it updates to the final name after merging video and audio.
- This makes it obvious which item to pause, retry or cancel when several downloads are running at once.

## Tap the video to play and pause on mobile

- With **Pause on mobile tap** enabled, tapping anywhere on the picture now works both ways: tap to pause, tap again to resume. Previously only pausing worked, and the second tap just hid the controls.
- The play/pause button updates to match, and after resuming the controls stay up for a moment so you can see the state before they fade.
- Taps on the overlay buttons and the progress bar are unchanged — they still handle their own action and never toggle playback by accident.
- With the setting turned off, tapping the picture keeps its original behaviour: it only shows or hides the controls.

## Notes

- Nothing changes about configuration: yt-dlp and ffmpeg are still required for YouTube downloads.
