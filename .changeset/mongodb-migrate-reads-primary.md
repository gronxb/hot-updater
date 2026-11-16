---
"@hot-updater/server": patch
---

fix(server): MongoDB's `db migrate` reads `release_catalog_partitions`' collation on the primary. On a client whose read preference allows secondaries, the check read the collection and its indexes from a secondary that might not have replicated the collection the migration had just created, and failed with `ns does not exist`.
