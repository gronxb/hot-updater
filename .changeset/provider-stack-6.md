---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"@hot-updater/mock": patch
---

Centralize database commit, channel and Insights validation, read-model planning, and lazy lifecycle in the internal adapter factory. Preserve native and transactional execution paths and the existing public custom-provider contract.

Execute D1 commit preconditions in order inside the atomic batch, including expectation-only commits, and report conflicts from that execution without separate snapshot reads. Roll back earlier changes when a later update or reference check fails.

Bound PostgreSQL single-row reads and apply requested projections, including version-only commit expectations.

Page patch-owner reads with an ID cursor and deduplicated owner IDs, preserving one multi-owner query per page without repeatedly consuming offset prefixes.
