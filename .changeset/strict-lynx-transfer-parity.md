---
"@hot-updater/lynx": patch
---

Reject trailing compressed bytes after an iOS Brotli stream, including data past
the decoder's input buffer boundary. On Android, report BSDIFF fallback only
after attempting an eligible patch; an absent or mismatched native base uses
the verified original without producing patch-failure evidence.
