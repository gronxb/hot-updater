---
"@hot-updater/postgres": patch
---

Commit PostgreSQL event source counters atomically with direct and mixed writes.
Add explicit DB tooling for schema cutover, bounded legacy-event backfill and
committed-prefix reads without exposing private source columns in event results.

Deployments must apply the source migration during a maintenance window before
using the new writer. Unmarked old-writer inserts are rejected after cutover;
raw event data is preserved. Exact report generation remains a separate step.
