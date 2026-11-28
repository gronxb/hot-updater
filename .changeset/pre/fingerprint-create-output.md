---
"hot-updater": patch
"@hot-updater/expo": patch
"@hot-updater/plugin-core": patch
---

Fix `hot-updater fingerprint create`'s output.

- When `fingerprint.json` already records the fingerprint, it prints only that the file is up to date. It no longer prints `Created fingerprint.json` first.
- When `fingerprint.json` isn't valid JSON, as a merge conflict leaves it, it says it rewrote the file. It no longer says the file changed or asks for a rebuild.
- An Expo project whose `app.json` or `app.config.*` lists `@hot-updater/expo` no longer gets the Expo CNG warning from `fingerprint create`. Without the plugin, the warning shows the `plugins` entry intact.
- `hot-updater keys export-public` warns an Expo CNG project unless the `@hot-updater/expo` plugin sets `publicKeyPath`: without it, the next prebuild removes the key the command writes into the native files. The warning shows the plugin entry with `publicKeyPath`. Build adapters' `getNativeProjectValues` can report that file as `publicKeyPath`.
