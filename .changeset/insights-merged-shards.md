---
"@hot-updater/server": minor
---

Keep the Insights rollout gate robust under load.

- **Shards:** the plugin's gauges and sketches, which are read, merged, and written back, get 16 shards. Its blind counters keep 8.
- **Unchanged merges:** the engine skips an aggregate write that leaves the stored row unchanged, such as a sketch that already counts the installation.

At the gate's rate, 1.3% of transactions are now retried, against 2.4% before; a loaded run at 8 shards went past 5%.
