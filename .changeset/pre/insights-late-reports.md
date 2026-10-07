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

Insights no longer miscounts two report orders. A launch report made, by its event ID, before the installation's latest report is late even after a later report, such as a user switch or the next day's launch, replaced the apply it preceded: it no longer counts a launch and a download of the bundle the installation left, or moves the installation back to it. A download that repeats the installation's pending one, from the same bundle to the same bundle, counts nothing, so a download reported twice before its launch counts once and the launch implies no second one. Both are kept in history as late reports, as before; the Console notes that the installation had already downloaded or run the bundle. Event IDs are made on the device, so a device whose clock jumps back has its launch reports judged late until its clock passes its latest report.
