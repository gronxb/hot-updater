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
- `hot-updater db catalog preflight` and `db catalog rebuild` are removed. When `hot-updater.config.ts` sets `server`, `doctor` compares each release catalog with a rebuild from its releases and reports `RELEASE_CATALOG_STALE`, or `RELEASE_CATALOG_IDENTITY_MISSING` for a catalog row to restore from backup. A database doctor cannot reach is the warning `RELEASE_CATALOGS_UNCHECKED`, never a failure.
- `hot-updater bundle preflight` is removed. `bundle update --dry-run` takes the same options and validates the update and shows the projected catalog, without saving or asking.
- `hot-updater bundle artifact delete` is removed. Deleting a release deletes its artifact record when no other release uses it, with the patches built on it, whether the CLI, the console, or the admin API deletes it. `bundle delete` says so, and its `--json` output names the artifact in `deletedArtifactId`. Stored files stay until `storage prune`.
- `hot-updater patch` no longer takes the hidden `--bundle-id` and `--base-bundle-id` aliases. Use `--artifact-id` and `--base-artifact-id`.
- `hot-updater keys export-public` no longer takes `-i, --input <path>`. It exports the configured signing key.
- `hot-updater build:android` needs `EXPERIMENTAL`, like `build:ios`, `run:android`, and `run:ios`.

`hot-updater doctor --fix` runs the repairs doctor can make itself: it rebuilds stale release catalogs from their releases, and writes what `fingerprint create`, `keys export-public --yes`, and `keys remove --yes` write. It names every catalog and file it writes, in the output and in `details.fixes`, and checks again. It skips native files that `expo prebuild` generates, and ends by asking for a native rebuild when it wrote native files.

`@hot-updater/protocol` exports `parseReleaseCatalog`, the check a client runs on a fetched release catalog, with `hasExpectedReleaseCatalogScope`, `ExpectedReleaseCatalogScope`, `MAX_RELEASE_CATALOG_WIRE_BYTES`, and `getUtf8ByteLength`. The React Native update client and doctor's server checks both run it.

`@hot-updater/test-utils` exports `storeBundles`, which stores bundles with no release through the storage engine.
