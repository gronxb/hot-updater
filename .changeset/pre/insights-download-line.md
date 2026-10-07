---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
---

Release health's **Adoption** draws each bundle's downloads as a dashed line beside its launches, solid, in the bundle's color, per interval, and its table shows both counts for the period. After a forced update the two lines nearly meet; otherwise launches follow downloads as apps restart. The **Per interval** and **Cumulative** switch is gone, with its `adoptionTotal` URL value. The Console uses one vocabulary, Downloaded, Launched, and Crashed: event lists name `UPDATE_APPLIED` **Launched** and `RECOVERED` **Crashed**, Release health's crash count is **Crashed**, a download waiting for a restart is **Not launched yet**, and the Release health and bundle tooltips are a sentence or two.

A download that a launch or crash implied, when its download report never arrived, now counts in the bundle's `UPDATE_DOWNLOADED` outcome counter too, in the hour of that launch or crash. So `countEventSeries` and `countEvents` for a bundle's downloads cover the downloads its release counts, and the reporting overview's `downloadedReports` counts them in whole hours. The launch or crash stays the row, so a download filter's counter can exceed the download rows its hour holds. No table changes: no migration is needed.
