---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"@hot-updater/mock": patch
---

Centralize database commit, channel and Insights validation, read-model planning, and lazy lifecycle in the internal adapter factory. Preserve native and transactional execution paths and the existing public custom-provider contract.
