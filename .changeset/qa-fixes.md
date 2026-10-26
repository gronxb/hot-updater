---
"@hot-updater/cli-tools": minor
"hot-updater": minor
"@hot-updater/android-helper": minor
---

Fixes from integrated QA.

- The CLI masks a stored value shorter than six characters, such as `1`, only where it is a whole word, as in `PASSWORD=1`, so URLs and versions stay readable.
- `hot-updater channel delete --json` keeps stdout one JSON document when a native build keeps the channel.
- `native-build android` prints "App Module" in its Gradle settings.
