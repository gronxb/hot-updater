---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/cli-tools": patch
"@hot-updater/console": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"@hot-updater/standalone": patch
"@hot-updater/bare": patch
"@hot-updater/expo": patch
"@hot-updater/rock": patch
"@hot-updater/sentry-plugin": patch
"@hot-updater/datadog-plugin": patch
"@hot-updater/bugsnag-plugin": patch
---

What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.

- `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, and `BundleSigningPlugin` is `BundleSigningAdapter`. There are no aliases.
- The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.
