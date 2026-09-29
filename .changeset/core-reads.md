---
"@hot-updater/server": minor
---

Add core's schema and reads on the storage engine; `hotUpdater.core` exposes the reads.

- **Schema:** `bundles`, `bundle_patches`, `releases`, `release_catalogs`, and `channels`, with the PRD's indexes and references, plus the `bundle_totals` counter.
- **Update check and artifacts:** the update check is one point read of its scope's catalog. Artifact resolution is one batch read of both bundles plus one unique read of their patch.
- **Bundles:** a bundle's patches are read exactly as its reference counter says, and its child count is the counter on its row.
- **Auto-patch bases:** a new bundle's bases come from one point read of its scope's catalog, which holds every enabled bundle release of the scope.
- **Engine:** `findByKeys` reads rows by key in one batch.
