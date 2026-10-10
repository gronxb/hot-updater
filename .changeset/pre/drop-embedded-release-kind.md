---
"@hot-updater/protocol": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/console": patch
"hot-updater": patch
"@hot-updater/react-native": patch
---

Remove the `EMBEDDED` Release kind. Every Release points at a Bundle, and a device goes back to its built-in bundle through the `BUILTIN` selection.

- `getActiveUpdateState().kind` is `"BUNDLE"` or `"BUILTIN"`, and `transitionKind` no longer includes `"USE_EMBEDDED"`; no server creates bundle-less Releases.
- `ReleaseKind` and `ReleaseRow.kind` are `"BUNDLE"`. The `kind` column and the `kind` field of catalog descriptors stay, so no migration is needed and catalogs are unchanged.
- `parseReleaseCatalog` accepts only `BUNDLE` descriptors that carry a `bundleId`.
- `compileReleaseCatalog` rejects an enabled Release without a Bundle with `INVALID_RELEASE`.
