---
"@hot-updater/server": minor
"@hot-updater/plugin-core": patch
"@hot-updater/test-utils": patch
---

Add the write side of the built-in Insights plugin at `@hot-updater/server/plugins/insights`. `insights()` declares these models:

- `bundle_events`, with a derived `day` and `movement_install_id` and a multi-valued `bundle_ref`
- `bundle_event_heads`
- five aggregates, all sharded by install id: overview counters, user sketches, the latest-installation distribution, latest events by bundle, and outcome counters

`api.recordEvent(event)` records one validated event in one transaction. It reads the event and its installation's head in one batch, reads the gauge and sketch rows it changes in a second, then writes once.

- A repeated id changes nothing.
- A newer event moves the head and its gauges.
- An older event still counts in its own hour.
- Channel and usage rows also roll up by day.

Also in this change:

- The SQL core no longer creates an index whose columns repeat the primary key.
- `@hot-updater/plugin-core/internal` exports `assertBundleEventRow` and `createValidatedInsightsModel`.
- The plugin test harness returns the plugin's database handle.
