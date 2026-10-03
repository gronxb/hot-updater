---
"@hot-updater/server": minor
---

A server checks that its storage serves downloads (`get` and `getDownloadUrl`) where it first reads `hotUpdater.handlers`, so the CLI and the console can run `createHotUpdater` over the storage in their config, which only uploads.
