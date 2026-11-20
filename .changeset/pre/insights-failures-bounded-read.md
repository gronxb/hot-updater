---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/test-utils": patch
---

fix(insights): the Console's update failures view reads at most 20 breakdown rows from each hour of its period, however many failures a client reports.

- The view read every breakdown row of its period. Each row is one release, stage, reason and detail of an hour, and a detail carries the storage error code a client reports. So anyone with the app's API key could add rows that every view of the channel then read.
- The view now reads newest first. An hour that holds more than 20 rows is read no further, and the read goes on from the hour before it. A real channel holds a handful of rows an hour, and an incident across several releases and error codes still fits. A day reads at most 480 rows, and 30 days 14,400.
- Such an hour is listed in the new `cappedHours`, and the view's coverage is partial. Its failures count only in part, so the Console marks the failure counts and the attempt failure rate "≥", and the card Partial. Every other hour counts every failure, and downloads and installations count in full. "All platforms" keeps either platform's capped hours.
- `setupReadBudgetTestSuite` pins the bound on every adapter with a flooded channel of its own, its rows on all 8 shards.
