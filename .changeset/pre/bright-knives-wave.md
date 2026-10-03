---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
---

Show daily observed bundle shares in Release health while retaining its scope totals and moving launch failures to a separate chart tab. Count each reporting installation once on its day's last observed running bundle, preserve previous days, and include built-in and unknown bundles in the denominator. Show gaps without observations, the unfinished current day, app-version filtering, and tooltip counts.

Insights schema 1.3.0 adds daily observation heads and distribution history. Migrate the server and Console together; history begins after upgrade and is not backfilled. The shared model and HTTP conformance suites cover daily replacement and historical preservation, and the versioned infrastructure guide documents each provider's upgrade.
