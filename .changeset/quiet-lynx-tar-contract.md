---
"@hot-updater/lynx": patch
---

Remove unused iOS ZIP/GZIP extraction paths and their zlib linkage. Bulk Lynx
installation requires the manifest's TAR.BR size and file inventory; verified
original-file fallback and individual Brotli decoding are unchanged.
