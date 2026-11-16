---
"@hot-updater/plugin-core": patch
"@hot-updater/test-utils": patch
---

feat(plugin-core): a lossless app-version tiling for release catalogs, not yet used by the server.

- `compileReleaseCatalogTiling` and `tileCompiledReleaseCatalog` turn a scope's enabled releases, or its stored compact catalog, into rows that tile the app-version line. Each row holds one of the compiler's merged segments with every descriptor that applies to it, and every gap gets an empty row. The 256 KB and 512-cohort caps apply to each row instead of the whole scope, and a refusal names the row's app versions.
- `insertReleaseIntoTiling` adds a new release to the rows its range covers, without merging any rows. `releaseCatalogKeyRanges` names those rows.
- `assembleReleaseCatalog` turns the rows back into the compiler's compact payload, byte for byte. It carries no hash.
- `releaseCatalogLookupKey` and `projectReleaseCatalogPartition` find and project a device's row.
- `@hot-updater/test-utils` adds the differential oracle against today's compiler, and v1.0.0's vendored release selector.

Nothing in the server reads or writes these rows yet, and no schema changes.
