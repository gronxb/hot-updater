---
"@hot-updater/server": minor
"@hot-updater/postgres": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"hot-updater": minor
---

Create schema 1.0.0 from empty databases only. `db migrate` and `db generate` no longer accept or upgrade v0 schema markers, and managed SQL templates are a single 1.0.0 CREATE.
