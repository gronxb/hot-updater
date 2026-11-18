---
"@hot-updater/plugin-insights": patch
---

fix(insights): the Console's update failures view reads at most 10 breakdown rows an hour of its period, and at least a day's worth (240), however many failures a client reports.

- The view read every breakdown row of its period. Each row is one release, stage, reason and detail of an hour, and a detail carries the storage error code a client reports. So anyone with the app's API key could add rows that every view of the channel then read.
- The view now reads newest first and stops at the bound: 240 rows for a day, 7,200 for 30 days. A real channel holds a handful of rows an hour.
- Past the bound, it leaves out the oldest hour it read, which may be cut short. Its failures, downloads and installations then all count from the hour after, so rates never mix two ranges, and it reports its coverage as partial from there. The Console marks the card Partial.
