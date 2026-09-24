---
"@hot-updater/server": minor
---

Add core's schema and reads on the storage engine; `hotUpdater.core` exposes the reads.

- **Schema:** `bundles`, `bundle_patches`, `releases`, `release_catalogs`, and `channels`, with the PRD's indexes and references, plus the `bundle_totals` counter and the `base_candidates` gauge.
- **Update check and artifacts:** the update check is one point read of its scope's catalog. Artifact resolution is one batch read of both bundles plus one unique read of their patch.
- **Bundles:** a bundle's patches are read exactly as its reference counter says, and its child count is the counter on its row.
- **Auto-patch bases:** an enabled bundle release holds one `base_candidates` key for its fingerprint, or one per minor line of its range (at most 16). A new bundle searches its single key below its own id.
- **Engine:** `findByKeys` reads rows by key in one batch.
