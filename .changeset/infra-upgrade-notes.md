---
"hot-updater": patch
---

The 1.0.0 infrastructure upgrade notes that `hot-updater infra scaffold` writes no longer ask a release candidate deployment to apply schema additions in place, or to look for tables and columns that the storage engine replaced. A release candidate's database is recreated: a D1 database that recorded `0001_hot-updater_1.0.0.sql` gets a new database or dropped tables before the scaffold's migrations, and the Worker waits for `schema.engine`.
