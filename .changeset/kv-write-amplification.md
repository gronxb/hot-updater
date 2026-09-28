---
"@hot-updater/server": patch
---

Write fewer items per Insights event on DynamoDB and Firestore.

- **Gauge patches:** the key-value helper leaves an aggregate's metrics out of its index copies, as it leaves out counters, and index reads take them from the rows. A guarded gauge patch now rewrites only its row item, so moving an installation between two populated hours writes 2 `insights_distribution` items instead of 6. Copies written before still read right, since reads take the metric from the row.
- **Bundle refs:** `bundle_events.bundle_ref` now holds only the ref a bundle filter reads: `from:<bundle>` for `RECOVERED`, and `to:<bundle>` for the other types. A movement event writes one `byBundle` entry instead of two, on every backend. Events recorded before keep both refs, and no filter reads the extra one.

On B3's rollout, a move writes 20.7 items instead of 25.6 on the key-value helper.
