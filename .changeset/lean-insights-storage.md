---
"@hot-updater/plugin-core": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
---

Replace the bounded Insights scan/report lifecycle with a five-operation
database contract for event append, keyset-paginated event history, latest
installation lookup, exact current-user lookup, and active-installation count.
Store a compact latest-installation projection, remove unused analytics indexes,
and keep all official provider configuration unchanged.
