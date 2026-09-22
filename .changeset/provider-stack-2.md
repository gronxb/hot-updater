---
"@hot-updater/server": patch
---

Push Prisma null ordering and MongoDB filtering and pagination into native queries. Finite MongoDB ID and patch-owner predicates can use indexes instead of collection scans.

Push ORM read projections into native queries so revision and generation checks fetch only requested fields. Keep MongoDB ordering on non-nullable fields on the native cursor path when explicit null ordering is supplied.
