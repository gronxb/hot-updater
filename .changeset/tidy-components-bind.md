---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
---

Add versioned universal component schemas and a provider-neutral append and
ordered-scan data adapter. Feature plugins declare and own their schema history,
structured checks, and legacy-adoption policy, while database providers bind
generic data sources and execute or generate version-tagged migrations without
importing feature contracts. Storage checks preserve exact physical drift
detection while validation-only checks enforce domain rows without rewriting
legacy constraints. Runtime access fails closed until physical shape, stored
rows, and the component marker match the latest declared version.

Publish a synthetic component conformance suite for provider implementations.
