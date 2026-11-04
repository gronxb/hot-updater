---
"hot-updater": patch
---

Fix fingerprint findings from the 1.2.0-rc.17 QA.

- `hot-updater doctor` reports a missing `fingerprint.json` for a fingerprint project without native folders, such as an Expo project that generates them at prebuild: `MISSING_FINGERPRINT_JSON`, with `npx hot-updater fingerprint create` as the next step. Without native folders it also compares an existing `fingerprint.json` with the project's fingerprint whether or not the build adapter reads a native signing key. It used to pass.
- `hot-updater fingerprint create` on a project without `fingerprint.json` says only that it created the file, and to commit it. It no longer prints `fingerprint.json changed.` and `Rebuild the native app to embed the new fingerprint.`, which it keeps for a change to an existing file.
