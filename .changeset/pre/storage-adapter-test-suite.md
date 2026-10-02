---
"@hot-updater/test-utils": minor
---

Add `setupStorageAdapterTestSuite`, which checks a storage adapter against what deploy, patch, the Console, the server, and `hot-updater storage prune` rely on. It streams bodies through `put` with and without a `contentLength` and reads them back through `get`. It checks that `put` returns the canonical URI of each key below the base path, including keys with spaces, `#`, `%`, and Unicode, and that the URIs deploy derives from a manifest's URI resolve. It also covers `exists`, a `null` response for a missing object, an idempotent `delete`, rejecting URIs of another bucket or protocol, `getDownloadUrl`, and `listObjects` and `deleteObjects` with keys relative to the base path. It skips the cases of operations an adapter does not implement, or requires the ones passed as `operations`. Every official storage adapter runs it.
