---
"@hot-updater/server": patch
---

Add explicit MongoDB native-event preparation with preserved database validators,
simple-collation indexes, guarded event writes and durable bounded old-data audit.
Mixed BSON keys and short byte-limited responses resume without hidden refills or
skipped events. Raw event fields remain unchanged.

The tooling prepares event browsing only; MongoDB report source capture and the
required public Insights query replacement remain separate implementation work.
