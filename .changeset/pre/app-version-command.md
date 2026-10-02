---
"hot-updater": minor
---

`hot-updater app-version` is back. It prints the app version each native project builds, and `--json` prints `{ "android": ..., "ios": ... }`, with `null` for a platform it can't read, for release scripts that pass the version to `deploy -t`. `doctor` still shows the same versions in its native status.
