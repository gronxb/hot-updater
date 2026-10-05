---
"@hot-updater/console": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
---

Rebuild Release health around one question: is a newly deployed bundle taking over, and is it crashing? It follows the two newest bundle deployments of the channel and platform, or a focused release and the one deployed before it, on the card's timeline (hourly for 24h, every six hours for 7d, daily for 30d), with each deployment marked and one color per bundle. Add a bundle from the ten newest deployments, up to four, or remove one; the choice and the tab are kept in the URL. **Adoption** charts the installations that applied each bundle, with its update failures; **Crashes** charts the launches that crashed on each bundle and recovered, with its crash rate, and recommends rolling a bundle back once it crashes for 5% of at least 20 installations that tried it. **Roll back** disables its release, as the bundle details do. A bundle's update failures or crashes open the Failures details on it, and View adoption on a bundle opens Release health on it.

Remove what the old Release health used: the Bundle share chart and its daily observation heads, the Downloads and Adoption tabs, the metrics row, and the Launch failures tab. Insights drops `getDistributionHistory`, the `bundle_daily_heads` and `insights_distribution_history` tables, the per-report daily head writes, the per-hour release launch sketches, launches on hourly and daily rows (a release keeps its lifetime count), and the unread recent-events index; a repeated launch on the same UTC day writes nothing again, and a daily launcher costs about 38 DynamoDB write units a day instead of 58. `getReleaseActivity` reads lifetime release counts only, without `coverage`. The DynamoDB batching gate holds each event's batched aggregate writes to a budget instead of a ratio to the now cheaper transactional writes. It adds `countEventSeries`, a bundle filter's event counts per interval read from the hourly counts it already keeps. The Insights schema returns to the 1.0.0 baseline, version 1.2.0, without the 1.0.0-rc.30 migrations. Upgrade the Console and the plugin together: a 1.0.0-rc.30 Console cannot read Release health from this plugin. A database already migrated to 1.0.0-rc.30 records Insights 1.3.0, which this server refuses: set its `schema.insights` setting back to `1.2.0`, and on SQL databases drop the `bundle_daily_heads` and `insights_distribution_history` tables.
