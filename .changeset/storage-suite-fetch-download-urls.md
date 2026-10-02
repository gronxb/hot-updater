---
"@hot-updater/test-utils": minor
---

`setupStorageAdapterTestSuite` takes `fetchDownloadUrls`. With it, the suite fetches every `http(s)` URL `getDownloadUrl` returns and requires the object's bytes. Set it when the adapter runs against a bucket or emulator whose URLs the test can reach.
