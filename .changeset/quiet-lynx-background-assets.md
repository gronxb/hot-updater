---
"@hot-updater/lynx": minor
"@hot-updater/lynx-build": minor
---

Add an optional manifest-covered background JavaScript entry to the Lynx build
contract. Validate canonical paths, file coverage, bounded size, and UTF-8 content
on both native platforms while keeping metadata checks independent of downloads.
Reject NUL characters that the iOS runtime would truncate during execution.
