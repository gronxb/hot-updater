---
"@hot-updater/react-native": patch
---

iOS keeps a download that the background URLSession resumed after a network change. The system finishes such a download with `206 Partial Content`, and the size check compared the complete file with the resumed range only, so it discarded a valid archive and downloaded every file again. The check now uses the total from `Content-Range`, and skips the size when the total is unknown; the file hash is still verified.
