---
"@hot-updater/plugin-insights": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/azure": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"@hot-updater/vercel": patch
---

Insights keys Release health by release instead of by artifact, so two releases of one artifact in one channel and platform, as a promote back into the channel makes them, count their downloads, launches and crashes apart, and Roll back names the release that crashed. A release's installation count comes from the distribution rows, which already name the release, and `insights_latest_by_bundle` is no longer written. `hot-updater init` and `hot-updater db migrate` move the events a 1.1 server keyed by artifact in the raw period, with their hourly counts, to the release each names (`api.insights.backfillReleaseRefs()`), and can run again to move what a 1.1 server still running wrote after the migration.

The Insights model's bundle filters take `toReleaseId` and `fromReleaseId`, and `countLatestEvents` takes `releaseId` in place of `bundle` predicates. Event rows add `fromReleaseId`, and installation rows `lastKnownReleaseId`. The Console's event and installation views, the CLI's `insights events`, `installations` and `overview` (and their `--json`), and the distribution show the release ID, the bundle ID apps report; the distribution and the filter chips show its label too. The Insights release picker no longer matches artifact IDs.
