# @hot-updater/datadog-plugin

## 1.0.0-rc.28

### Patch Changes

- Updated dependencies [80bb792]
  - @hot-updater/protocol@1.0.0-rc.28
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.
- Updated dependencies
  - @hot-updater/plugin-core@1.0.0-rc.27
  - @hot-updater/protocol@1.0.0-rc.27

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.26
  - @hot-updater/protocol@1.0.0-rc.26

## 1.0.0-rc.25

### Patch Changes

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.25
  - @hot-updater/protocol@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.24
  - @hot-updater/protocol@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.23
  - @hot-updater/protocol@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- c9cfed7: Released with every Hot Updater package at 1.0.0-rc.22, so a project can install the same RC of each one.
- Updated dependencies [c9cfed7]
  - @hot-updater/plugin-core@1.0.0-rc.22
  - @hot-updater/protocol@1.0.0-rc.22

## 1.0.0-rc.21

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
- 4d15862: `@hot-updater/core` is renamed `@hot-updater/protocol`: the device-safe, zero-dependency package for what crosses a boundary, the formats and pure computations the app and the server share and the contracts between a host and its extensions on the device, such as the client plugin contract. `@hot-updater/plugin-core` is the kit that extends the server, with the adapter and server plugin contracts and their helpers: it runs wherever the server runs, and the app never imports it.
  - Import from `@hot-updater/protocol` where you imported `@hot-updater/core`. Every Hot Updater package that depended on `@hot-updater/core` depends on `@hot-updater/protocol` instead. `@hot-updater/core` stays on npm for 0.x.
  - `canonicalizeAppVersion` moves to `@hot-updater/protocol`, which bundles the version parsing it uses and has no dependencies. `@hot-updater/plugin-core` exports it as before.
  - `@hot-updater/react-native` no longer depends on `@hot-updater/plugin-core`: the app imports `@hot-updater/protocol` and the built-in Insights client, never `@hot-updater/plugin-core` or `@hot-updater/server`.
  - `@hot-updater/plugin-insights` takes `@hot-updater/plugin-core` as an optional peer dependency, which only its `./server` entry needs, and `@hot-updater/plugin-api-keys` as a peer dependency, so an app that installs `@hot-updater/react-native` no longer installs `@hot-updater/plugin-core`. A server gets it through `@hot-updater/server`.
  - Third-party server plugins and storage, build, and signing adapters import `@hot-updater/plugin-core` and list it in `peerDependencies`; client plugins do the same with `@hot-updater/protocol`. `@hot-updater/plugin-core` now also exports `addDistinct`, `countDistinct`, and `mergeDistinct`, so a plugin imports everything it needs from its root.
  - Client plugins import `defineClientPlugin` and its types from `@hot-updater/protocol`. `@hot-updater/react-native` still exports them for app code.
  - The `@hot-updater/react-native/plugins/insights` subpath is removed: import `insights` and its types from `@hot-updater/react-native`, as in `import { HotUpdater, insights } from "@hot-updater/react-native"`. Metro bundles the Insights client into every app, about 4 KB gzipped; it reports nothing until the app adds it to `plugins`. `hot-updater init` and the agent scaffold print that import, and `hot-updater doctor` looks for it.
  - `@hot-updater/protocol` exports the plugin host the SDK runs client plugins on, for any device SDK to reuse: `createPluginHost`, `pluginStorageKey`, `resolveBaseURL`, `HotUpdaterBaseURL`, and the `PluginHost*` types. `@hot-updater/react-native` has no subpaths, and `@hot-updater/test-utils/react-native` runs client plugins on protocol's host, without `@hot-updater/react-native` as a peer dependency.
  - `@hot-updater/cli-tools` adds `renderAppImports`, which groups the app's imports by module.
  - The `@hot-updater/plugin-core` root exports `definePlugin`, the schema DSL, the typed database handle, and the database errors.

- bb57f25: What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.
  - `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, `BundleSigningPlugin` is `BundleSigningAdapter`, and `DatabasePluginInputError` is `DatabaseAdapterInputError`. There are no aliases.
  - `@hot-updater/bare`, `@hot-updater/expo`, and `@hot-updater/rock`: their options types are `BareAdapterConfig`, `ExpoAdapterConfig`, and `RockAdapterConfig`.
  - The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

  Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.

- Updated dependencies [c9cfed7]
- Updated dependencies [5ec6796]
- Updated dependencies [ab04e15]
- Updated dependencies [f185d6d]
- Updated dependencies [ab04e15]
- Updated dependencies [4d15862]
- Updated dependencies [48cdd14]
- Updated dependencies [049fad1]
- Updated dependencies [61fcd51]
- Updated dependencies [bb57f25]
  - @hot-updater/protocol@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21

## 1.0.0-rc.17

### Patch Changes

- Updated dependencies [e696e69]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9a6715f]
- Updated dependencies [530cca5]
  - @hot-updater/plugin-core@1.0.0-rc.17

## 1.0.0-rc.16

### Patch Changes

- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [fe03f59]
- Updated dependencies [d482b13]
- Updated dependencies [2431c0a]
- Updated dependencies [ad00722]
- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [f6ffb68]
- Updated dependencies [c68e9f3]
- Updated dependencies [065c457]
- Updated dependencies [8a03eb2]
- Updated dependencies [aee193e]
- Updated dependencies [228b6c7]
- Updated dependencies [065c457]
- Updated dependencies [df31037]
  - @hot-updater/plugin-core@1.0.0-rc.16

## 1.0.0-rc.15

### Patch Changes

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/core@1.0.0-rc.15

## 1.0.0-rc.14

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/core@1.0.0-rc.14

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [663d8e9]
  - @hot-updater/plugin-core@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- Updated dependencies [51300d4]
- Updated dependencies [590ca70]
- Updated dependencies [a837c71]
  - @hot-updater/plugin-core@1.0.0-rc.2

## 1.0.0-rc.1

### Patch Changes

- Updated dependencies [6d0cdc7]
- Updated dependencies [8145d48]
  - @hot-updater/plugin-core@1.0.0-rc.1

## 1.0.0-rc.0

### Major Changes

- adb0e40: Release HotUpdater 1.0 with the Release Catalog architecture.

### Patch Changes

- Updated dependencies [3b367e7]
- Updated dependencies [b424d47]
- Updated dependencies [9650748]
- Updated dependencies [88c163a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [adb0e40]
- Updated dependencies [e2455c5]
- Updated dependencies [25af6ef]
- Updated dependencies [c355c26]
- Updated dependencies [7ec1a46]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/core@1.0.0-rc.0

## 0.36.0

### Patch Changes

- Updated dependencies [9759e8a]
  - @hot-updater/plugin-core@0.36.0
  - @hot-updater/core@0.36.0

## 0.35.12

### Patch Changes

- Updated dependencies [6e8b32e]
  - @hot-updater/plugin-core@0.35.12
  - @hot-updater/core@0.35.12

## 0.35.11

### Patch Changes

- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/core@0.35.11

## 0.35.10

### Patch Changes

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/core@0.35.10

## 0.35.9

### Patch Changes

- @hot-updater/core@0.35.9
- @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- @hot-updater/core@0.35.8
- @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/core@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/core@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/core@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/core@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/core@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/core@0.35.2
- @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/core@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Patch Changes

- @hot-updater/core@0.35.0
- @hot-updater/plugin-core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [088f6c1]
- Updated dependencies [7244b65]
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/core@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/core@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/core@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [e914f56]
  - @hot-updater/plugin-core@0.33.0
  - @hot-updater/core@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [4e6d2ec]
  - @hot-updater/plugin-core@0.32.0
  - @hot-updater/core@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/core@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/core@0.31.3
- @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/core@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/core@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Patch Changes

- Updated dependencies [5b0a0f5]
- Updated dependencies [5b0a0f5]
  - @hot-updater/core@0.31.0
  - @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/core@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/core@0.30.11
- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/core@0.30.10
- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/core@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- Updated dependencies [6019156]
  - @hot-updater/plugin-core@0.30.8
  - @hot-updater/core@0.30.8

## 0.30.7

### Patch Changes

- @hot-updater/core@0.30.7
- @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/core@0.30.6
- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/core@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/core@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/core@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/core@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/core@0.30.1
- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/core@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/core@0.29.8
- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/core@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- @hot-updater/core@0.29.6
- @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/core@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/core@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/core@0.29.3

## 0.29.2

### Patch Changes

- Updated dependencies [2a1bc80]
  - @hot-updater/core@0.29.2
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- @hot-updater/core@0.29.1
- @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/core@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/core@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/core@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/core@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- 648cd1b: chore(aws): bump packages
  - @hot-updater/core@0.26.2
  - @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/core@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/core@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/core@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/core@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/core@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/core@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [03c5adc]
  - @hot-updater/plugin-core@0.25.10
  - @hot-updater/core@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/core@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/core@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/core@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/core@0.25.6
- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/core@0.25.5
- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- @hot-updater/core@0.25.4
- @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/core@0.25.3
- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/core@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/core@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/core@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/core@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- @hot-updater/core@0.24.6
- @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/core@0.24.5
- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/core@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/core@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/core@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/core@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/core@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/core@0.23.1
- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [e41fb6b]
  - @hot-updater/core@0.23.0
  - @hot-updater/plugin-core@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/core@0.22.2
- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/core@0.22.1
- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/core@0.22.0
- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/plugin-core@0.21.15
- @hot-updater/core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/core@0.21.14
- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/core@0.21.13
- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/core@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [e2b67d7]
  - @hot-updater/core@0.21.11
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/plugin-core@0.21.10
- @hot-updater/core@0.21.10

## 0.21.9

### Patch Changes

- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/core@0.21.9

## 0.21.8

### Patch Changes

- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/core@0.21.8

## 0.21.7

### Patch Changes

- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7
  - @hot-updater/core@0.21.7

## 0.21.6

### Patch Changes

- @hot-updater/core@0.21.6
- @hot-updater/plugin-core@0.21.6

## 0.21.5

### Patch Changes

- @hot-updater/core@0.21.5
- @hot-updater/plugin-core@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4
  - @hot-updater/core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/core@0.21.3
- @hot-updater/plugin-core@0.21.3

## 0.21.2

### Patch Changes

- @hot-updater/core@0.21.2
- @hot-updater/plugin-core@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1
  - @hot-updater/core@0.21.1

## 0.22.0

### Minor Changes

- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0
  - @hot-updater/core@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15
  - @hot-updater/core@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14
  - @hot-updater/core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/core@0.20.13
- @hot-updater/plugin-core@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/core@0.20.12
- @hot-updater/plugin-core@0.20.12

## 0.20.11

### Patch Changes

- Updated dependencies [cb9c05b]
  - @hot-updater/plugin-core@0.20.11
  - @hot-updater/core@0.20.11

## 0.20.10

### Patch Changes

- @hot-updater/core@0.20.10
- @hot-updater/plugin-core@0.20.10

## 0.20.9

### Patch Changes

- @hot-updater/core@0.20.9
- @hot-updater/plugin-core@0.20.9

## 0.20.8

### Patch Changes

- Updated dependencies [ad7c999]
  - @hot-updater/plugin-core@0.20.8
  - @hot-updater/core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/plugin-core@0.20.7
  - @hot-updater/core@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6
  - @hot-updater/core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/core@0.20.5
- @hot-updater/plugin-core@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - @hot-updater/plugin-core@0.20.4
  - @hot-updater/core@0.20.4

## 0.20.3

### Patch Changes

- Updated dependencies [e63056a]
  - @hot-updater/plugin-core@0.20.3
  - @hot-updater/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2
  - @hot-updater/core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies [a3a4a28]
  - @hot-updater/plugin-core@0.20.1
  - @hot-updater/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [bc8e23d]
  - @hot-updater/plugin-core@0.20.0
  - @hot-updater/core@0.20.0

## 0.19.10

### Patch Changes

- 9c373a6: Introduce Datadog plugin for sourcemaps upload
- Updated dependencies [2bc52e8]
  - @hot-updater/plugin-core@0.19.10
  - @hot-updater/core@0.19.10
