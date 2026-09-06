---
"@hot-updater/plugin-core": patch
---

Strip leading and trailing slashes from the storage `basePath` in `createStorageKeyBuilder` so a value like `/releases/` no longer produces object keys with an empty path segment.
