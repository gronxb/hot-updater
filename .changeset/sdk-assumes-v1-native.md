---
"@hot-updater/react-native": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/protocol": patch
"@hot-updater/plugin-core": patch
---

The React Native SDK calls its native module directly and requires `rollbackReleases` in every Release catalog.

- `@hot-updater/react-native` calls `getInstallId()`, `getStorageItem()`, `setStorageItem()`, and the Release catalog methods of its native module without checking that they exist. Every native build of the SDK implements them.
- The `insights()` client treats a `400` to an `UPDATE_FAILED` report like any other `400`: it doesn't retry, it logs a warning, and it reports the failure again when it happens again.
- `ReleaseCatalog.rollbackReleases` is required. `parseReleaseCatalog` rejects a catalog without it, and `selectDesiredRelease` looks for rollback candidates only there. Hot Updater servers always send it.
- `projectCompiledRollbackCatalog` reads only the compiled catalog's `rollbackReleaseIndexes`, which `compileReleaseCatalog` always writes.
