---
"@hot-updater/core": minor
---

Allow native clients to exclude unconfirmed Release IDs from update and rollback
selection without excluding every Release that references the same Bundle.
Include those exclusions in selection context hashes while preserving existing
hashes when no exclusions are supplied.
