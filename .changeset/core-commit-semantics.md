---
"@hot-updater/server": minor
"@hot-updater/plugin-core": patch
---

Move core's writes onto the new database engine. Nothing public changes yet: C3's legacy façade serves today's `DatabasePlugin` through these writes, and E1 moves the CLI and admin API onto the typed release changes.

- **Release changes rooted at the catalog:** `changeReleases` deploys, updates, or deletes a release and writes its scope's next catalog generation in one transaction. It reads only the catalog row, the scope's enabled releases, and the latest release id (`byScope` descending, limit 1). A concurrent change in the same scope bumps the catalog row, so the transaction reruns instead of publishing a stale catalog. New ids are assigned after the latest release.
- **Catalog rebuilds:** `rebuildCatalog` recompiles a catalog from the enabled releases and rewrites it only when it changed.
- **Legacy commits:** `commitLegacyChanges` keeps today's `DatabaseCommit` results (`not_found`, `referenced`, and `version_conflict`), with patch cascades from either bundle. A release written without its catalog gets a placeholder catalog that reads as absent.
- **Channels:** channel insert returns the existing row on a name conflict, including under a race. Channel delete reports `not_found` or `not_empty`.
- **Aggregates:** bundle totals and auto-patch base candidates are kept in the same transactions as the rows.
- **Engine:** rows found through a rooted range can be updated or deleted in that transaction, guarded by their root.
- **`@hot-updater/plugin-core/internal`:** exports `validateDatabaseCommit`.
