---
"@hot-updater/azure": patch
---

`azureBlobStorage` imports `node:stream` statically instead of on each read.
