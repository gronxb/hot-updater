---
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
---

Insights event lists cover one time range, as other analytics products list raw events. The global and bundle lists take `[sinceMs, beforeReceivedAtMs)` of at most 90 × 24 hours; without `sinceMs` they list the 90 days before the cutoff, and a longer range answers 400. Pages run newest first and stop at the range start: only a full page returns a cursor, which carries the range and the page's last row. Each event also counts itself in a per-day row of `insights_outcomes` (platform `*`), so a list skips days without matching events: after an empty day, one outcome read (that row for the global list, the filter's own hourly rows for a bundle list) names the next day that holds one, and a gap of any length costs two reads. The Insights plugin's `listEvents` rejects a global or bundle range longer than 90 × 24 hours. The read-budget suite measures a dense day, a gap, and an empty range.
