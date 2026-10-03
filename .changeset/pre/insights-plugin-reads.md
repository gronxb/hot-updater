---
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
---

Add the read side of the built-in Insights plugin: `listEvents`, `findLatestEvents`, `countLatestEvents`, `countEvents`, `getReleaseActivity`, and `getAppUsage`. `createInsightsModel(api)` serves them through the `InsightsModel` contract the console and CLI read.

How each read is served:

- Event lists read one index range per day, going back at most 90 days.
- A latest event is one point read.
- Counts and activity read hour counters, gauges, and sketches, and windows over 48 hours read channel and usage day rollups.
- Only the partial hours at the edge of a millisecond window fall back to raw rows.

Engine changes:

- Range bounds accept a prefix of the order tuple.
- Aggregate rows are read in parallel at commit.
- `retry.onRetry` receives the failed attempt's number.

`@hot-updater/test-utils` adds `setupInsightsModelTestSuite`, which runs the Insights report contract against an `InsightsModel`.
