---
"@hot-updater/plugin-remote-config": minor
"@hot-updater/server": minor
"@hot-updater/react-native": minor
"@hot-updater/console": minor
"@hot-updater/plugin-core": patch
"@hot-updater/standalone": patch
"@hot-updater/test-utils": patch
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

Add Remote Config: change values the app reads without a new build or bundle.

- **Server:** `remoteConfig()` from `@hot-updater/server/plugins/remote-config` stores templates of parameters (String, Number, Boolean, or JSON, each with a default value or the app's in-app default) and conditions on platform, channel, app version range, cohort, a percentage of installs over the numeric cohorts, fingerprint, and a date and time range on the server's clock. Conditions are ordered: the first one that matches and that a parameter has a value for decides it. Every publish is a version; `hotUpdater.api.remoteConfig` publishes against the version an edit started from (`conflict` otherwise), rolls back by publishing a copy, lists versions, and resolves what a device gets. Devices fetch `GET /remote-config` on the client handler, which answers only their values, cacheable for five seconds with an `ETag`, from one keyed read of the active template that each server reuses for five seconds. Admin routes manage templates for the Console. Templates are at most 60,000 characters of JSON. `hot-updater db migrate` creates its `remote_config_active` and `remote_config_versions` tables.
- **App:** `remoteConfig({ defaults, minimumFetchIntervalMs })` from `@hot-updater/react-native` goes in `HotUpdater.init`'s `plugins`, fetches on its `baseURL`, headers, and timeout, and is `hotUpdater.remoteConfig` on the instance `init` returns, typed by its `defaults`. `getValue`, `getString`, `getNumber`, `getBoolean`, and `getAll` read synchronously: the active remote value, else the in-app default, else `null`, with `remote` and `default` sources. `false`, `0`, and `""` are values; a key `defaults` declares is typed non-null and any other key `T | null`; `fetch` and `activate` move new values in, with a 12-hour minimum fetch interval that a change of channel, app version, cohort, or fingerprint skips. Activated values persist on the device and load before `init` returns, and `subscribe` reports activations.
- **Console:** a Remote Config page edits a draft's parameters and conditions, previews what a device gets, publishes it with a summary of changes, and lists versions to view and roll back, over the database or a self-hosted server's admin API.
- **Managed servers:** the AWS, Cloudflare, Firebase, and Supabase servers run `remoteConfig()` beside `insights()` and `apiKeys()`, and their initialization schema creates its tables.
- **`standaloneRepository`:** `fetchAdmin(path, init?)` sends any method, body, and headers to the server's admin handler, after the repository's headers.
