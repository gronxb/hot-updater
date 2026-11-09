---
"@hot-updater/neon": patch
---

Add `neonDatabase` to `@hot-updater/neon`: Hot Updater's database on a Neon branch's Postgres through Neon's HTTP driver, so it runs in Workers, edge functions, and Node without a connection pool. Each write is one atomic batch over HTTP, and `hot-updater db migrate` creates its tables.
