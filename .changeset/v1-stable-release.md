---
"@hot-updater/android-helper": major
"@hot-updater/apple-helper": major
"@hot-updater/aws": major
"@hot-updater/bare": major
"@hot-updater/bsdiff": major
"@hot-updater/bugsnag-plugin": major
"@hot-updater/cli-tools": major
"@hot-updater/cloudflare": major
"@hot-updater/console": major
"@hot-updater/datadog-plugin": major
"@hot-updater/expo": major
"@hot-updater/firebase": major
"@hot-updater/plugin-api-keys": major
"@hot-updater/plugin-core": major
"@hot-updater/plugin-insights": major
"@hot-updater/plugin-remote-config": major
"@hot-updater/postgres": major
"@hot-updater/protocol": major
"@hot-updater/react-native": major
"@hot-updater/rock": major
"@hot-updater/sentry-plugin": major
"@hot-updater/server": major
"@hot-updater/standalone": major
"@hot-updater/supabase": major
"@hot-updater/test-utils": major
"hot-updater": major
---

Hot Updater 1.0, the first stable release of v1. Deploys create Releases that the server compiles into one cacheable Release Catalog per app scope, and `createHotUpdater` runs a storage adapter, a database adapter, and plugins such as Insights, Remote Config, and client API keys. v1 runs on new infrastructure and needs a new native app build: follow the [upgrade guide](https://hot-updater.dev/docs/guides/upgrade-to-v1) and [BREAKING_CHANGES.md](https://github.com/gronxb/hot-updater/blob/main/BREAKING_CHANGES.md) to move from v0.
