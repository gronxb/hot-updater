---
"@hot-updater/server": patch
"@hot-updater/postgres": patch
---

Keep Kysely optional when loading the common server or CLI. Export Kysely
Insights helpers from `@hot-updater/server/adapters/kysely` and update the
Postgres plugin to use that entrypoint.
