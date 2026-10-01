---
"@hot-updater/protocol": minor
"@hot-updater/plugin-core": minor
"@hot-updater/react-native": patch
"@hot-updater/server": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/plugin-api-keys": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/test-utils": patch
"@hot-updater/cli-tools": minor
"hot-updater": patch
---

`@hot-updater/core` is renamed `@hot-updater/protocol`: the device-safe, zero-dependency package for what crosses a boundary, the formats and pure computations the app and the server share and the contracts between a host and its extensions on the device, such as the client plugin contract. `@hot-updater/plugin-core` is the kit that extends the server, with the adapter and server plugin contracts and their helpers: it runs wherever the server runs, and the app never imports it.

- Import from `@hot-updater/protocol` where you imported `@hot-updater/core`. Every Hot Updater package that depended on `@hot-updater/core` depends on `@hot-updater/protocol` instead. `@hot-updater/core` stays on npm for 0.x.
- `canonicalizeAppVersion` moves to `@hot-updater/protocol`, which bundles the version parsing it uses and has no dependencies. `@hot-updater/plugin-core` exports it as before.
- `@hot-updater/react-native` no longer depends on `@hot-updater/plugin-core`: the app imports `@hot-updater/protocol` and the built-in Insights client, never `@hot-updater/plugin-core` or `@hot-updater/server`.
- `@hot-updater/plugin-insights` takes `@hot-updater/plugin-core` as an optional peer dependency, which only its `./server` entry needs, and `@hot-updater/plugin-api-keys` as a peer dependency, so an app that installs `@hot-updater/react-native` no longer installs `@hot-updater/plugin-core`. A server gets it through `@hot-updater/server`.
- Third-party server plugins and storage, build, and signing adapters import `@hot-updater/plugin-core` and list it in `peerDependencies`; client plugins do the same with `@hot-updater/protocol`. `@hot-updater/plugin-core` now also exports `addDistinct`, `countDistinct`, and `mergeDistinct`, so its root has everything `@hot-updater/server/plugins` exports.
- The `@hot-updater/react-native/client-plugin` subpath is removed: import `defineClientPlugin` and its types from `@hot-updater/protocol`. `@hot-updater/react-native` still exports them for app code.
- The `@hot-updater/react-native/plugins/insights` subpath is removed: import `insights` and its types from `@hot-updater/react-native`, as in `import { HotUpdater, insights } from "@hot-updater/react-native"`. Metro bundles the Insights client into every app, about 4 KB gzipped; it reports nothing until the app adds it to `plugins`. `hot-updater init` and the agent scaffold print that import, and `hot-updater doctor` looks for it.
- `@hot-updater/protocol` exports the plugin host the SDK runs client plugins on, for any device SDK to reuse: `createPluginHost`, `pluginStorageKey`, `resolveBaseURL`, `HotUpdaterBaseURL`, and the `PluginHost*` types. The `@hot-updater/react-native/plugin-host` subpath is removed, so the SDK has no subpaths, and `@hot-updater/test-utils/react-native` runs client plugins on protocol's host, without `@hot-updater/react-native` as a peer dependency.
- `@hot-updater/cli-tools` adds `renderAppImports`, which groups the app's imports by module.
- The `@hot-updater/plugin-core/server-plugin` subpath is removed. `definePlugin`, the schema DSL, the typed database handle, and the database errors are exported from the `@hot-updater/plugin-core` root, and `@hot-updater/server/plugins` exports them as before.
