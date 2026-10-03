---
"hot-updater": minor
"@hot-updater/server": minor
"@hot-updater/protocol": minor
"@hot-updater/react-native": patch
"@hot-updater/console": patch
"@hot-updater/test-utils": minor
---

CLI commands exist only for user workflows. Checks move into `hot-updater doctor`, which can now repair what it finds with `--fix`, and plumbing commands are removed, with no aliases:

- `hot-updater app-version` is removed. `doctor` shows each platform's app version in its native status, as `appVersion` in `--json`.
- Bare `hot-updater channel` shows help. `doctor` shows the native default channels, and `channel set` stays.
- Bare `hot-updater fingerprint` shows help. Under the fingerprint update strategy, `doctor` compares `fingerprint.json` with the project's fingerprint and reports `FINGERPRINT_JSON_STALE` with the sources that changed, or `FINGERPRINT_GENERATION_FAILED`. `fingerprint create` stays.
- `hot-updater db catalog preflight` and `db catalog rebuild` are removed. When `hot-updater.config.ts` sets `database`, `doctor` opens it once per run and checks every scope that has a catalog row or a release:
  - `RELEASE_CATALOG_STALE` is a catalog that differs from a rebuild from its releases;
  - `RELEASE_CATALOG_IDENTITY_MISSING` is a scope whose releases have no catalog row, which devices get 404 for. The row must be restored from backup;
  - `RELEASE_CATALOG_CHECK_FAILED` is a scope core cannot compile, reported beside the other scopes' results;
  - a database doctor cannot reach is the warning `RELEASE_CATALOGS_UNCHECKED`, never a failure.
- `hot-updater bundle preflight` is removed. `bundle update --dry-run` takes the same options and validates the update and shows the projected catalog, without saving or asking.
- `hot-updater bundle artifact delete` is removed. Deleting a release deletes its artifact record when no other release uses it, whether the CLI, the console, or the admin API deletes it.
  - Every patch to or from that artifact goes with it, so a device running the deleted bundle downloads its next update in full.
  - `bundle delete` says so, and its `--json` output names the artifact in `deletedArtifactId`.
  - Stored files stay until `storage prune`.
  - Artifact records that an earlier release candidate's `bundle delete` left behind show up in `doctor` as `UNREFERENCED_ARTIFACTS`. `doctor --fix` deletes them, and `storage prune` then reclaims their files.
- `hot-updater patch` no longer takes the hidden `--bundle-id` and `--base-bundle-id` aliases. Use `--artifact-id` and `--base-artifact-id`.
- `hot-updater keys export-public` no longer takes `-i, --input <path>`. It exports the configured signing key.
- `hot-updater build:android` needs `EXPERIMENTAL`, like `build:ios`, `run:android`, and `run:ios`.

`hot-updater doctor --fix` runs the repairs doctor can make itself:
- it rebuilds stale release catalogs from their releases;
- it deletes the artifact records no release uses;
- it writes what `fingerprint create` writes, where it differs;
- it writes what `keys export-public --yes` writes.

It names every write, in the output and in `details.fixes`, and checks again.

It skips native files that `expo prebuild` generates. It never removes a public key: an issue with more than one remedy, such as `ORPHAN_PUBLIC_KEY`, stays report-only. When it wrote a native file, it ends by asking for a native rebuild.

`@hot-updater/protocol` exports `parseReleaseCatalog`, the check a client runs on a fetched release catalog, with `hasExpectedReleaseCatalogScope`, `ExpectedReleaseCatalogScope`, `MAX_RELEASE_CATALOG_WIRE_BYTES`, and `getUtf8ByteLength`. The React Native update client and doctor's server checks both run it.

`@hot-updater/test-utils` exports `storeBundles`, which stores bundles with no release through the storage engine.
