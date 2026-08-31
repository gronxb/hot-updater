---
"@hot-updater/core": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
"@hot-updater/react-native": minor
"@hot-updater/console": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
---

Remove user-managed Catalog authority from configuration, generated provider
environments, deployment output, and public React Native update state. Catalogs
receive an opaque identity on their first atomic commit and preserve it across
updates, rebuilds, and tombstones. CLI and server share the persisted identity
without configuration. Native stale-generation and unexpected-Catalog guards
remain in place.

This changes the unreleased v1 database schema and internal JS/native protocol
together. Catalog rows are part of persistent history and must be included in
backups; a missing row with retained Releases cannot be regenerated safely.
