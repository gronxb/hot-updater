# @hot-updater/plugin-remote-config

## 1.0.0-rc.46

### Patch Changes

- Updated dependencies [47638d6]
  - @hot-updater/protocol@1.0.0-rc.46

## 1.0.0-rc.45

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.45

## 1.0.0-rc.44

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.44

## 1.0.0-rc.43

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.43

## 1.0.0-rc.42

### Minor Changes

- 72fd2de: The CLI manages Remote Config and reads Insights, as the Console does, on the server `hot-updater api-key` finds: `database` and `plugins` in `hot-updater.config.ts`, the server's admin routes through `standaloneRepository`, or the server file passed last.
  - **`hot-updater remote-config`:** `show` (`--version-number` for a published version), `versions`, `publish <file>`, `rollback <version>`, and `preview`. `publish` takes a template or what `show --json` printed, validates it, lists what it adds, changes, and removes, and asks first (`-y` to skip, `--dry-run` to stop before it). It publishes after the version the file was read at, or `--expected-version`, so a newer publish is never replaced, and the active template publishes nothing. `preview` evaluates the active template, a version, or a `--file` for a device's platform, channel, app version, cohort, fingerprint, and time.
  - **`hot-updater insights`:** `overview`, `failures`, `events`, and `installations`, with the Console's words: a bundle's Downloaded, Launched, and Crashed reports, update failure rates and their stages and reasons, reports by outcome or installation, and installations by install or user ID. `--bundle` takes the ID shown in the Console and reads the bundle's platform and channel; `--window` is `24h`, `7d`, or `30d`.
  - **Plugins:** `createRemoteConfigAdminApi(fetchAdmin)` is Remote Config over a server's admin routes, answering as `RemoteConfigApi` does, and `createInsightsAdminReads(fetchAdmin)` and `createInsightsReads(api)` are the Insights reads over the admin routes or the plugin's API. The Console and the CLI share them.

### Patch Changes

- @hot-updater/protocol@1.0.0-rc.42

## 1.0.0-rc.41

### Minor Changes

- 545f059: `HotUpdater.init` returns the app's HotUpdater instance: every HotUpdater method, including `wrap`, and each client plugin's API under the plugin's id, typed from `plugins`.
  - **Client plugin contract:** `setup(context)` returns `{ hooks, api }`, either of them, or nothing. `api` is what the app calls, as `hotUpdater.<id>`; a plugin id cannot be the name of an instance member, such as `reload` or `wrap`. A `setup` that returns hooks at the top level, as before, is reported through `onError` and gets no hooks. `ClientPluginApi`, `ClientPluginApis`, and `HotUpdaterClientSetup` type it; `HotUpdaterInstance` and `HotUpdaterCore` type the instance.
  - **Insights:** `setUser` moves from the plugin object to `hotUpdater.insights.setUser`. `insights()` keeps its context, device state, and delivery queue per `setup`, so one plugin object set up by two instances reports through each instance's own server. The launch report waits for native launch verification, so a user set right after `init` is on the first report.
  - **Remote Config:** the reads, `fetch`, `activate`, and `subscribe` are on `hotUpdater.remoteConfig`; the plugin object has only `id` and `setup`.
  - **Tests:** `setupClientPlugin` returns the plugin's `api`, and `setupClientPlugins` the plugins' `apis` by id.

- 545f059: Add Remote Config: change values the app reads without a new build or bundle.
  - **Server:** `remoteConfig()` from `@hot-updater/server/plugins/remote-config` stores templates of parameters (String, Number, Boolean, or JSON, each with a default value or the app's in-app default) and conditions on platform, channel, app version range, cohort, a percentage of installs over the numeric cohorts, fingerprint, and a date and time range on the server's clock. Conditions are ordered: the first one that matches and that a parameter has a value for decides it. Every publish is a version; `hotUpdater.api.remoteConfig` publishes against the version an edit started from (`conflict` otherwise), rolls back by publishing a copy, lists versions, and resolves what a device gets. Devices fetch `GET /remote-config` on the client handler, which answers only their values, cacheable for five seconds with an `ETag`, from one keyed read of the active template that each server reuses for five seconds. Admin routes manage templates for the Console. Templates are at most 60,000 characters of JSON. `hot-updater db migrate` creates its `remote_config_active` and `remote_config_versions` tables.
  - **App:** `remoteConfig({ defaults, minimumFetchIntervalMs })` from `@hot-updater/react-native` goes in `HotUpdater.init`'s `plugins`, fetches on its `baseURL`, headers, and timeout, and is `hotUpdater.remoteConfig` on the instance `init` returns, typed by its `defaults`. `getValue`, `getString`, `getNumber`, `getBoolean`, and `getAll` read synchronously: the active remote value, else the in-app default, else `null`, with `remote` and `default` sources. `false`, `0`, and `""` are values; a key `defaults` declares is typed non-null and any other key `T | null`; `fetch`, `activate`, and `fetchAndActivate` move new values in, with a 12-hour minimum fetch interval, which a failed fetch does not start, and which `fetch({ force: true })` and a change of channel, app version, cohort, or fingerprint skip; `lastFetchStatus` and `fetchedAtMs` report the last fetch. Activated values persist on the device and load before `init` returns, and `subscribe` reports activations.
  - **Console:** a Remote Config page edits a draft's parameters and conditions, previews what a device gets, publishes it with a summary of changes, and lists versions to view and roll back, over the database or a self-hosted server's admin API.
  - **Managed servers:** the AWS, Cloudflare, Firebase, and Supabase servers run `remoteConfig()` beside `insights()` and `apiKeys()`, and their initialization schema creates its tables.
  - **`standaloneRepository`:** `fetchAdmin(path, init?)` sends any method, body, and headers to the server's admin handler, after the repository's headers.

### Patch Changes

- Updated dependencies [545f059]
- Updated dependencies [545f059]
  - @hot-updater/protocol@1.0.0-rc.41
