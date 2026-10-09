---
"hot-updater": minor
"@hot-updater/plugin-insights": minor
"@hot-updater/plugin-remote-config": minor
"@hot-updater/console": patch
---

The CLI manages Remote Config and reads Insights, as the Console does, on the server `hot-updater api-key` finds: `database` and `plugins` in `hot-updater.config.ts`, the server's admin routes through `standaloneRepository`, or the server file passed last.

- **`hot-updater remote-config`:** `show` (`--version-number` for a published version), `versions`, `publish <file>`, `rollback <version>`, and `preview`. `publish` takes a template or what `show --json` printed, validates it, lists what it adds, changes, and removes, and asks first (`-y` to skip, `--dry-run` to stop before it). It publishes after the version the file was read at, or `--expected-version`, so a newer publish is never replaced, and the active template publishes nothing. `preview` evaluates the active template, a version, or a `--file` for a device's platform, channel, app version, cohort, fingerprint, and time.
- **`hot-updater insights`:** `overview`, `failures`, `events`, and `installations`, with the Console's words: a bundle's Downloaded, Launched, and Crashed reports, update failure rates and their stages and reasons, reports by outcome or installation, and installations by install or user ID. `--bundle` takes the ID shown in the Console and reads the bundle's platform and channel; `--window` is `24h`, `7d`, or `30d`.
- **Plugins:** `createRemoteConfigAdminApi(fetchAdmin)` is Remote Config over a server's admin routes, answering as `RemoteConfigApi` does, and `createInsightsAdminReads(fetchAdmin)` and `createInsightsReads(api)` are the Insights reads over the admin routes or the plugin's API. The Console and the CLI share them.
