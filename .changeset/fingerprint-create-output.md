---
"hot-updater": patch
---

Fix `hot-updater fingerprint create`'s output.

- When `fingerprint.json` already records the fingerprint, it prints only that the file is up to date. It no longer prints `Created fingerprint.json` first.
- It repairs a `fingerprint.json` that isn't valid JSON, as a merge conflict leaves, and compares the result with the committed file. It asks for a rebuild only when a hash differs from the committed one. When there is no committed file, it says it rewrote the file.
- An Expo project whose `app.json` or `app.config.*` lists `@hot-updater/expo` no longer gets the Expo CNG warning. Without the plugin, the warning shows the `plugins` entry intact. `hot-updater keys export-public` gets the same fix.
