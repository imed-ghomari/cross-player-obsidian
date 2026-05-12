# Cross Player 1.2.7

This patch release fixes the Obsidian community review issues and aligns the published release assets with the repository.

Highlights:
- Added a repository license and cleaned up plugin metadata for community submission.
- Replaced the Obsidian v1.8.7-only local storage calls with browser-compatible storage so the plugin remains valid for `minAppVersion` 1.7.2.
- Removed hostname-based device naming and other review-triggering runtime patterns.
- Updated the release workflow to generate GitHub artifact attestations for future releases.
