---
"hot-updater": patch
"@hot-updater/plugin-core": patch
---

Write `fingerprint.json` only when the data it records changes, and in a stable format.

- `fingerprint create`, `hot-updater build`, `init`, and the Expo config plugin at prebuild compare the fingerprints, sources, and inputs `fingerprint.json` records with the new ones, and write the file only when they differ. A file formatted by your formatter stays as it is until the data changes. A file that isn't a `fingerprint.json`, such as one with merge conflict markers, is replaced.
- The file is written with two-space indentation, a final newline, and short arrays on one line, which Prettier 3 and oxfmt at `printWidth: 80` leave unchanged. It no longer records `debugInfo`. Fingerprint hashes don't change.
- An existing `fingerprint.json` switches to this format the first time its recorded data changes after you upgrade. An older `hot-updater` writing the same file can switch it back.
- `hot-updater doctor` reports a `fingerprint.json` that isn't valid JSON, as after a merge conflict, as `INVALID_FINGERPRINT_JSON` instead of `MISSING_FINGERPRINT_JSON`.
- The `fingerprint.debug` option's description now says what it does: the build adapter may use it for its own diagnostics, and `fingerprint.json` never records them.
