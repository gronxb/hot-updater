---
"@hot-updater/console": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/test-utils": patch
---

Replace Release health's Adoption tab with Downloads, which shows whether a new bundle is taking over: each line is one bundle's download reports per interval of the period on the card's timeline, hourly for 24h, every six hours for 7d, and daily for 30d, with each deployment marked. It starts with the two newest bundle deployments of the channel and platform; remove one from the table under the chart, add one of the ten newest deployments up to four, or return to the newest two, and the choice is kept in the URL. View downloads on a bundle's Insights card opens the tab with that bundle and the one deployed before it. Rollbacks to the built-in bundle are not listed.

The tab reads only while it is open: the newest deployments once per channel and platform for five minutes, and each bundle's counters once, so adding a bundle reads only that bundle. A `getReleaseActivity` release read in `intervalMs` intervals now reads counters alone and leaves out `uniqueUsers`, skipping the sketch rows it never needed; the read budget suite pins it on every adapter.

Upgrade the Console with the plugin. The 1.0.0-rc.30 Console reads `uniqueUsers` from an `intervalMs` read for a Release ID's Active installations, so against this plugin it would show 0 there; this Console no longer passes `intervalMs` for Release health.
