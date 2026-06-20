---
"@hot-updater/server": minor
"hot-updater": minor
---

Make the `@hot-updater/server` root export runtime-safe, remove the ambiguous `@hot-updater/server/runtime` subpath, keep `@hot-updater/server/node` focused on `toNodeHandler`, and move database generation, migration, and bundle diff APIs to `@hot-updater/server/db`.
