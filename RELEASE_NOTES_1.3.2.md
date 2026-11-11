# Cross Player 1.3.2

Downloads are calmer to watch now. The queue only gains a file once it has finished downloading, notifications arrive one per file, the total progress bar holds its line, and the download panel looks like it was always part of Obsidian.

## Only finished files reach the queue

- Downloading one link used to add several entries: yt-dlp writes each stream to a temporary fragment first, and those fragments were treated as real media. They now stay out of your vault, so a download adds exactly one item when it is done.
- The queue no longer changes while a video is still being fetched.

## One notification per file

- You get a single **Added to queue** notice when a file has finished downloading, instead of a stream of notices per file.
- Scanning the watched folder is quiet now, so starting Obsidian or refreshing the folder no longer produces a notice for every file.

## A steady total progress bar

- Each download's progress only moves forward. Mixed formats (video plus audio), audio conversion, and the final processing step can no longer push a bar backwards.
- The total keeps its position when another download joins the batch or a finished one leaves the list, so it reads as steady progress rather than up-and-down movement.

## Smoother queue while downloading

- The download panel no longer redraws itself on every yt-dlp status line, so scrolling stays smooth while files are arriving.
- The queue keeps its scroll position and no longer shifts sideways when its scrollbar appears.

## A download panel that belongs in Obsidian

- The section now uses Obsidian's own colours, spacing, icons and type scale instead of custom values, so it matches the rest of the app in light and dark themes.
- Each file shows its name, percentage, and speed · ETA above a slim accent progress bar.
- Pause, Resume, Retry and Cancel are now small icon buttons that appear on hover — and stay visible on touch screens.
- The header keeps its download icon, file count and chevron, and clicking it still collapses the panel.

## Notes

- How downloads are configured has not changed: yt-dlp and ffmpeg are still required for YouTube downloads.
