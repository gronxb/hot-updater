---
"@hot-updater/postgres": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
---

Add bounded PostgreSQL installation movement pages with explicit partial-index
preparation and an internal indexed latest-installation lookup. Preserve complete
installation identities and account for escaped scope size in event cursors.
Missing or incompatible indexes fail before history reads without a scan fallback.
