---
"hot-updater": patch
---

Fix `hot-updater fingerprint create`'s output.

- When `fingerprint.json` already records the fingerprint, it prints only that the file is up to date. It no longer prints `Created fingerprint.json` first.
- When `fingerprint.json` isn't valid JSON, as a merge conflict leaves it, it says it rewrote the file. It no longer says the file changed or asks for a rebuild.
- An Expo project whose `app.json` or `app.config.*` lists `@hot-updater/expo` no longer gets the Expo CNG warning. Without the plugin, the warning shows the `plugins` entry intact. `hot-updater keys export-public` gets the same fix.
