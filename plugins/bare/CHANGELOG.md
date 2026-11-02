# @hot-updater/bare

## 1.2.0-rc.13

### Patch Changes

- Updated dependencies [b54eddc]
- Updated dependencies [ad99046]
- Updated dependencies [20006f2]
- Updated dependencies [ef790db]
  - @hot-updater/plugin-core@1.2.0-rc.13
  - @hot-updater/cli-tools@1.2.0-rc.13

## 1.2.0-rc.12

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.12
  - @hot-updater/plugin-core@1.2.0-rc.12

## 1.2.0-rc.11

### Patch Changes

- Updated dependencies [4c10736]
  - @hot-updater/cli-tools@1.2.0-rc.11
  - @hot-updater/plugin-core@1.2.0-rc.11

## 1.2.0-rc.10

### Patch Changes

- Updated dependencies [41444fa]
- Updated dependencies [fd2aa7e]
  - @hot-updater/cli-tools@1.2.0-rc.10
  - @hot-updater/plugin-core@1.2.0-rc.10

## 1.2.0-rc.9

### Patch Changes

- Updated dependencies [12ff126]
  - @hot-updater/cli-tools@1.2.0-rc.9
  - @hot-updater/plugin-core@1.2.0-rc.9

## 1.2.0-rc.8

### Patch Changes

- Updated dependencies [8a440e3]
- Updated dependencies [2e3f250]
- Updated dependencies [21cfeec]
- Updated dependencies [c463534]
- Updated dependencies [5358377]
  - @hot-updater/cli-tools@1.2.0-rc.8
  - @hot-updater/plugin-core@1.2.0-rc.8

## 1.2.0-rc.7

### Patch Changes

- Updated dependencies [f3989de]
  - @hot-updater/cli-tools@1.2.0-rc.7
  - @hot-updater/plugin-core@1.2.0-rc.7

## 1.2.0-rc.6

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.6
  - @hot-updater/plugin-core@1.2.0-rc.6

## 1.2.0-rc.5

### Patch Changes

- Updated dependencies [dd7db4b]
- Updated dependencies [709997a]
- Updated dependencies [5d4d977]
- Updated dependencies [2fd1c83]
  - @hot-updater/cli-tools@1.2.0-rc.5
  - @hot-updater/plugin-core@1.2.0-rc.5

## 1.2.0-rc.4

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.4
  - @hot-updater/plugin-core@1.2.0-rc.4

## 1.2.0-rc.3

### Patch Changes

- Updated dependencies [3c00e7a]
  - @hot-updater/cli-tools@1.2.0-rc.3
  - @hot-updater/plugin-core@1.2.0-rc.3

## 1.2.0-rc.2

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.2
  - @hot-updater/plugin-core@1.2.0-rc.2

## 1.2.0-rc.1

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.1
  - @hot-updater/plugin-core@1.2.0-rc.1

## 1.2.0-rc.0

### Patch Changes

- Updated dependencies [6276804]
- Updated dependencies [d7f02a6]
- Updated dependencies [8c675a2]
- Updated dependencies [28dfe97]
- Updated dependencies [e97d063]
- Updated dependencies [84b21f0]
- Updated dependencies [0050ff3]
- Updated dependencies [1ad0ebe]
- Updated dependencies [89cd5ce]
- Updated dependencies [f5cffc0]
- Updated dependencies [79c81f6]
- Updated dependencies [4d8e0d2]
- Updated dependencies [ed37acf]
- Updated dependencies [b78660b]
- Updated dependencies [4e4ddfb]
- Updated dependencies [f017e61]
- Updated dependencies [5e7a045]
  - @hot-updater/cli-tools@1.2.0-rc.0
  - @hot-updater/plugin-core@1.2.0-rc.0

## 1.1.5

### Patch Changes

- @hot-updater/cli-tools@1.1.5
  - @hot-updater/plugin-core@1.1.5

## 1.1.4

### Patch Changes

- @hot-updater/cli-tools@1.1.4
  - @hot-updater/plugin-core@1.1.4

## 1.1.3

### Patch Changes

- @hot-updater/cli-tools@1.1.3
  - @hot-updater/plugin-core@1.1.3

## 1.1.2

### Patch Changes

- 5b6e176: Compile with the Hermes the app's React Native ships. A React Native before 0.83 bundles hermesc and has no `hermes-compiler` dependency, but `hermes-compiler` from another app in the workspace, such as one pnpm hoists, was reachable from it. The OTA bundle then held bytecode the app's Hermes refused to load ("Wrong bytecode version. Expected 96 but got 98").
- Updated dependencies [007e0c5]
  - @hot-updater/cli-tools@1.1.2
  - @hot-updater/plugin-core@1.1.2

## 1.1.1

### Patch Changes

- @hot-updater/cli-tools@1.1.1
  - @hot-updater/plugin-core@1.1.1

## 1.1.0

### Minor Changes

- ffc0e23: Native builds embed their own fingerprint. A build step in the HotUpdater pod (or its Swift Package Manager plugin) and in the Android library writes the fingerprint into the binary before compiling, so a binary always carries the fingerprint of the native interface it was built from. `fingerprint create` no longer writes `HOT_UPDATER_FINGERPRINT_HASH` into `Info.plist` or `com.hotupdater.FINGERPRINT_HASH` into `AndroidManifest.xml`, and the native SDK no longer reads them.
  - `fingerprint.json` records the inputs each fingerprint came from: the build adapter and its fingerprint settings.
  - A Release build runs the new `npx hot-updater fingerprint hash -p <platform>`. It computes the fingerprint from those inputs without loading `hot-updater.config.ts`, so build machines need no deploy secrets.
  - A Debug build uses the hash `fingerprint.json` holds.
  - A `fingerprint.json` without `inputs`, written by an earlier `hot-updater`, is embedded as recorded with a warning, as is one whose build adapter is installed in a version without the new fingerprint export, so upgrading the React Native package alone doesn't break release builds.
  - The reverse, a `@hot-updater/react-native` that still reads the fingerprint from `Info.plist` and `AndroidManifest.xml`, makes `fingerprint create`, `deploy`, `doctor`, and the Expo config plugin stop and ask you to update it, instead of building an app with a stale fingerprint.
  - When the project changed after `fingerprint create`, the build still embeds the fingerprint it was built from and warns that `fingerprint.json` is stale.
  - An app without `fingerprint.json` builds with no fingerprint, as the appVersion strategy expects. Under appVersion, `doctor` reports a leftover `fingerprint.json` as `FINGERPRINT_JSON_UNUSED` (`doctor --fix` deletes it), `deploy` warns about it, the native build commands refuse to build, and the Expo config plugin removes it at prebuild.
  - Swift Package Manager builds always compute the fingerprint, since a package build plugin can't tell Debug from Release.
  - Set `HOT_UPDATER_APP_ROOT` (an Xcode build setting or environment variable, or a Gradle property) when the native projects are not in `<app>/ios` and `<app>/android`.
  - `HotUpdaterConfig`'s `fingerprintHash` and an instance's `HotUpdaterOptions.fingerprintHash` still take precedence over the embedded fingerprint. Named instances use the embedded fingerprint too, since every bundle comes from the project the build fingerprinted.

  doctor drops `MISSING_FINGERPRINT_HASH` and `FINGERPRINT_HASH_MISMATCH`, and the Expo config plugin writes `fingerprint.json` without injecting the hash.

- 7eaad78: Fingerprint Expo apps with Hot Updater's interface engine and drop `@expo/fingerprint`.
  - The Expo build adapter now provides its own fingerprint with the bare and Rock adapters' engine. It reads the native packages from Expo's autolinking (React Native CLI on SDKs before 52 or with `EXPO_USE_COMMUNITY_AUTOLINKING=1`), and `jsEngine` and `newArchEnabled` from the app config. It never reads the generated `ios/` and `android/` folders, so `fingerprint create` before `expo prebuild` and the native build after it compute the same fingerprint. Changing `jsEngine` or `newArchEnabled` now changes the fingerprint; it didn't before. `jsEngine` counts as `hermes` when the app config leaves it out, as Expo builds. Config plugins don't count, like edits to a bare app's native projects: bump `fingerprint.nativeVersion` when one changes what JavaScript can call.
  - `fingerprint hash` embeds the recorded fingerprint with a warning when the build adapter `fingerprint.json` records is not installed.
  - The interface engine no longer reads `Podfile.lock`, which only exists after `pod install` and depends on the machine that ran it. An iOS engine choice made by an environment variable at `pod install` goes through `fingerprint.nativeVersion`.
  - `hot-updater` no longer depends on `@expo/fingerprint`. A build adapter without its own fingerprint gets React Native CLI's.
  - Expo projects and bare iOS fingerprints change once, so builds made before the upgrade need a rebuild to keep receiving updates.

- 60db3ea: The bare and Rock build adapters fingerprint the native interface JavaScript calls with Hot Updater's own engine, `hot-updater/interface@1`, instead of `@expo/fingerprint`. The fingerprint covers:
  - the React Native version and its JavaScript engine (`hermesEnabled`, `hermesV1Enabled`, and `newArchEnabled` in `android/gradle.properties`);
  - each autolinked native package by name and version, Expo modules included;
  - the codegen specs of the app and of local native packages;
  - patches to those packages;
  - the new `fingerprint.nativeVersion` setting and `extraSources`.

  Version and build numbers, native implementation edits, build settings, and JavaScript-only dependencies no longer change it, so OTA updates keep reaching every store build with the same native interface.

  This changes the fingerprint of bare and Rock projects once. `doctor` and `deploy` report the change as an engine change. Run `npx hot-updater fingerprint create` and ship new store builds. Builds shipped with the old fingerprint receive no updates until users install a new build.

  Build adapters can provide their own fingerprint through `nativeBuild.fingerprint` (`NativeFingerprintProvider` in `@hot-updater/plugin-core`). The Expo adapter uses the same engine (see the Expo changeset). Fingerprint changes list values before and after, such as `react-native-screens 4.25.2 → 4.26.0`.

  When the channel's recent releases target other fingerprints, `deploy` lists them, so you see which builds the update won't reach.

### Patch Changes

- Updated dependencies [7eaad78]
- Updated dependencies [60db3ea]
  - @hot-updater/cli-tools@1.1.0
  - @hot-updater/plugin-core@1.1.0

## 1.0.8

### Patch Changes

- @hot-updater/cli-tools@1.0.8
  - @hot-updater/plugin-core@1.0.8

## 1.0.7

### Patch Changes

- @hot-updater/cli-tools@1.0.7
  - @hot-updater/plugin-core@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies [5702bf5]
  - @hot-updater/plugin-core@1.0.6
  - @hot-updater/cli-tools@1.0.6

## 1.0.5

### Patch Changes

- @hot-updater/cli-tools@1.0.5
  - @hot-updater/plugin-core@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies [33bdc32]
  - @hot-updater/cli-tools@1.0.4
  - @hot-updater/plugin-core@1.0.4

## 1.0.3

### Patch Changes

- Updated dependencies [407ec2c]
  - @hot-updater/cli-tools@1.0.3
  - @hot-updater/plugin-core@1.0.3

## 1.0.2

### Patch Changes

- Updated dependencies [ddfb139]
- Updated dependencies [d4d1d07]
  - @hot-updater/cli-tools@1.0.2
  - @hot-updater/plugin-core@1.0.2

## 1.0.1

### Patch Changes

- @hot-updater/cli-tools@1.0.1
  - @hot-updater/plugin-core@1.0.1

## 1.0.0

### Major Changes

- adb0e40: Hot Updater 1.0, the first stable release of v1. Deploys create Releases that the server compiles into one cacheable Release Catalog per app scope, and `createHotUpdater` runs a storage adapter, a database adapter, and plugins such as Insights, Remote Config, and client API keys. v1 runs on new infrastructure and needs a new native app build: follow the [upgrade guide](https://hot-updater.dev/docs/guides/upgrade-to-v1) and [BREAKING_CHANGES.md](https://github.com/gronxb/hot-updater/blob/main/BREAKING_CHANGES.md) to move from v0.

### Patch Changes

- Updated dependencies [adb0e40]
  - @hot-updater/cli-tools@1.0.0
  - @hot-updater/plugin-core@1.0.0

## 1.0.0-rc.47

### Patch Changes

- Updated dependencies [5891d9b]
- Updated dependencies [ccf3e2f]
- Updated dependencies [7132080]
- Updated dependencies [ccf3e2f]
  - @hot-updater/plugin-core@1.0.0-rc.47
  - @hot-updater/cli-tools@1.0.0-rc.47

## 1.0.0-rc.46

### Patch Changes

- Updated dependencies [47638d6]
- Updated dependencies [19be90f]
  - @hot-updater/cli-tools@1.0.0-rc.46
  - @hot-updater/plugin-core@1.0.0-rc.46

## 1.0.0-rc.45

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.45
  - @hot-updater/plugin-core@1.0.0-rc.45

## 1.0.0-rc.44

### Patch Changes

- Updated dependencies [92971a0]
- Updated dependencies [13d2119]
- Updated dependencies [13d2119]
  - @hot-updater/cli-tools@1.0.0-rc.44
  - @hot-updater/plugin-core@1.0.0-rc.44

## 1.0.0-rc.43

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.43
  - @hot-updater/plugin-core@1.0.0-rc.43

## 1.0.0-rc.42

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.42
  - @hot-updater/plugin-core@1.0.0-rc.42

## 1.0.0-rc.41

### Patch Changes

- Updated dependencies [545f059]
  - @hot-updater/plugin-core@1.0.0-rc.41
  - @hot-updater/cli-tools@1.0.0-rc.41

## 1.0.0-rc.40

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.40
  - @hot-updater/plugin-core@1.0.0-rc.40

## 1.0.0-rc.39

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.39
  - @hot-updater/plugin-core@1.0.0-rc.39

## 1.0.0-rc.38

### Patch Changes

- 136dd83: Always build the bundle. The bare build adapter no longer reads `HOT_UPDATER_BARE_BUILD_CACHE_DIR` and `HOT_UPDATER_BARE_BUILD_CACHE_KEY`, an undocumented build cache that only the repository's E2E tests used.
- @hot-updater/cli-tools@1.0.0-rc.38
  - @hot-updater/plugin-core@1.0.0-rc.38

## 1.0.0-rc.37

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.37
  - @hot-updater/plugin-core@1.0.0-rc.37

## 1.0.0-rc.36

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.36
  - @hot-updater/plugin-core@1.0.0-rc.36

## 1.0.0-rc.35

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.35
  - @hot-updater/plugin-core@1.0.0-rc.35

## 1.0.0-rc.34

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.34
  - @hot-updater/plugin-core@1.0.0-rc.30

## 1.0.0-rc.33

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.33
  - @hot-updater/plugin-core@1.0.0-rc.29

## 1.0.0-rc.32

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.32
  - @hot-updater/plugin-core@1.0.0-rc.29

## 1.0.0-rc.31

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.31
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.30

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.30
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.29

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.29
  - @hot-updater/plugin-core@1.0.0-rc.28

## 1.0.0-rc.28

### Patch Changes

- @hot-updater/cli-tools@1.0.0-rc.28

## 1.0.0-rc.27

### Patch Changes

- Improve the readability of Console update failures by grouping check metrics separately, emphasizing nonzero failures, and making stage/reason details easier to scan. Preserve all report data and rate calculations. Prepare all public Hot Updater packages together as 1.0.0-rc.27.
- Updated dependencies
  - @hot-updater/cli-tools@1.0.0-rc.27
  - @hot-updater/plugin-core@1.0.0-rc.27

## 1.0.0-rc.26

### Patch Changes

- c9cfed7: Restore the rc.14 Insights metric layout in bundle rows and details while preserving current data, rates, links, and download failure reporting. Release all public Hot Updater packages together as 1.0.0-rc.26.
- Updated dependencies [c9cfed7]
  - @hot-updater/cli-tools@1.0.0-rc.26
  - @hot-updater/plugin-core@1.0.0-rc.26

## 1.0.0-rc.25

### Patch Changes

- 1bdc12f: Restore the legacy Hermes binary path fallbacks after modern compiler and React Native bundled compiler detection. Check the local hermes-engine binary directly and retain the final hermesvm path without requiring package resolution.
- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.
- Updated dependencies [c9cfed7]
  - @hot-updater/cli-tools@1.0.0-rc.25
  - @hot-updater/plugin-core@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- cc34295: Resolve Expo config and fingerprint dependencies from the target app with Node's package resolver. Remove Expo config file-path fallbacks, honor evaluated dynamic and platform-specific JavaScript engine settings, and preserve config and dependency errors.

  Resolve React Native metadata through its package manifest and legacy Hermes binaries from the app's dependencies, including hoisted installations.

- c9cfed7: Release the project-scoped Expo, fingerprint, React Native, and Hermes resolution fixes at 1.0.0-rc.24 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [cc34295]
- Updated dependencies [c9cfed7]
  - @hot-updater/cli-tools@1.0.0-rc.24
  - @hot-updater/plugin-core@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- c9cfed7: Release with the Expo SDK 58 config fix at 1.0.0-rc.23 so projects can install the same RC of every Hot Updater package.
- Updated dependencies [c9cfed7]
  - @hot-updater/cli-tools@1.0.0-rc.23
  - @hot-updater/plugin-core@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- c9cfed7: Released with every Hot Updater package at 1.0.0-rc.22, so a project can install the same RC of each one.
- Updated dependencies [c9cfed7]
  - @hot-updater/cli-tools@1.0.0-rc.22
  - @hot-updater/plugin-core@1.0.0-rc.22

## 1.0.0-rc.21

### Patch Changes

- c9cfed7: Every package now shares one release candidate version: `hot-updater` and every `@hot-updater/*` package move to the same version, so an app, its server, and the console can pin one version.
- bb57f25: What fills one slot of a config is now an adapter: storage, build, database, and signing. What you list in `plugins` stays a plugin: server plugins, client plugins, and the Sentry, Datadog, and BugSnag integration plugins that wrap a build adapter.
  - `@hot-updater/plugin-core`: `StoragePlugin` is `StorageAdapter`, `createStoragePlugin` is `createStorageAdapter`, `StoragePluginWith` is `StorageAdapterWith`, `CreateStoragePluginOptions` is `CreateStorageAdapterOptions`, `BuildPlugin` is `BuildAdapter`, `BuildPluginConfig` is `BuildAdapterConfig`, `BasePluginArgs` is `BuildAdapterArgs`, `BundleSigningPlugin` is `BundleSigningAdapter`, and `DatabasePluginInputError` is `DatabaseAdapterInputError`. There are no aliases.
  - `@hot-updater/bare`, `@hot-updater/expo`, and `@hot-updater/rock`: their options types are `BareAdapterConfig`, `ExpoAdapterConfig`, and `RockAdapterConfig`.
  - The CLI, the server, and the console say "storage adapter", "build adapter", "database adapter", and "signing adapter" in their messages, such as `Storage adapter "<name>" does not implement <operation>.` and `No storage adapter for protocol: <protocol>`. `hot-updater init --build <adapter>` names its option accordingly.

  Package names and factory names do not change: `s3Storage()`, `r2Storage()`, `bare()`, `expo()`, `rock()`, `postgres()`, and the rest are configured as before.

- Updated dependencies [c9cfed7]
- Updated dependencies [ab04e15]
- Updated dependencies [f185d6d]
- Updated dependencies [ab04e15]
- Updated dependencies [4d15862]
- Updated dependencies [48cdd14]
- Updated dependencies [049fad1]
- Updated dependencies [61fcd51]
- Updated dependencies [bb57f25]
  - @hot-updater/cli-tools@1.0.0-rc.21
  - @hot-updater/plugin-core@1.0.0-rc.21

## 1.0.0-rc.17

### Patch Changes

- Updated dependencies [e696e69]
- Updated dependencies [9cd555b]
- Updated dependencies [9cd555b]
- Updated dependencies [9cd555b]
- Updated dependencies [1ddd5fc]
- Updated dependencies [9a6715f]
- Updated dependencies [530cca5]
  - @hot-updater/plugin-core@1.0.0-rc.17
  - @hot-updater/cli-tools@1.0.0-rc.17

## 1.0.0-rc.16

### Patch Changes

- Updated dependencies [d482b13]
- Updated dependencies [d482b13]
- Updated dependencies [fe03f59]
- Updated dependencies [8d60f68]
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
  - @hot-updater/cli-tools@1.0.0-rc.16

## 1.0.0-rc.15

### Patch Changes

- Updated dependencies [f5fffea]
- Updated dependencies [79c3eea]
- Updated dependencies [d99530b]
  - @hot-updater/plugin-core@1.0.0-rc.15
  - @hot-updater/cli-tools@1.0.0-rc.15

## 1.0.0-rc.14

### Patch Changes

- Align all Hot Updater packages on 1.0.0-rc.14 for a coordinated release candidate. Future releases continue to use independent package versions.
- Updated dependencies [479c1e5]
- Updated dependencies
- Updated dependencies [b23db5e]
  - @hot-updater/plugin-core@1.0.0-rc.14
  - @hot-updater/cli-tools@1.0.0-rc.14

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [663d8e9]
  - @hot-updater/plugin-core@1.0.0-rc.3
  - @hot-updater/cli-tools@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- Updated dependencies [51300d4]
- Updated dependencies [590ca70]
- Updated dependencies [a837c71]
  - @hot-updater/plugin-core@1.0.0-rc.2
  - @hot-updater/cli-tools@1.0.0-rc.2

## 1.0.0-rc.1

### Patch Changes

- Updated dependencies [6d0cdc7]
- Updated dependencies [8145d48]
  - @hot-updater/plugin-core@1.0.0-rc.1
  - @hot-updater/cli-tools@1.0.0-rc.1

## 1.0.0-rc.0

### Major Changes

- adb0e40: Release HotUpdater 1.0 with the Release Catalog architecture.

### Patch Changes

- Updated dependencies [3b367e7]
- Updated dependencies [b424d47]
- Updated dependencies [3b367e7]
- Updated dependencies [9650748]
- Updated dependencies [a9ffb2a]
- Updated dependencies [a9ffb2a]
- Updated dependencies [5a2e1cd]
- Updated dependencies [adb0e40]
- Updated dependencies [e2455c5]
- Updated dependencies [c8e24cd]
- Updated dependencies [25af6ef]
- Updated dependencies [c355c26]
- Updated dependencies [7ec1a46]
- Updated dependencies [a9ffb2a]
  - @hot-updater/plugin-core@1.0.0-rc.0
  - @hot-updater/cli-tools@1.0.0-rc.0

## 0.36.0

### Patch Changes

- Updated dependencies [9759e8a]
  - @hot-updater/cli-tools@0.36.0
  - @hot-updater/plugin-core@0.36.0

## 0.35.12

### Patch Changes

- Updated dependencies [fd30452]
- Updated dependencies [6e8b32e]
  - @hot-updater/cli-tools@0.35.12
  - @hot-updater/plugin-core@0.35.12

## 0.35.11

### Patch Changes

- Updated dependencies [1a3a621]
  - @hot-updater/plugin-core@0.35.11
  - @hot-updater/cli-tools@0.35.11

## 0.35.10

### Patch Changes

- Updated dependencies [ce8d254]
  - @hot-updater/plugin-core@0.35.10
  - @hot-updater/cli-tools@0.35.10

## 0.35.9

### Patch Changes

- Updated dependencies [8688b1a]
- Updated dependencies [f9bb26d]
  - @hot-updater/cli-tools@0.35.9
  - @hot-updater/plugin-core@0.35.9

## 0.35.8

### Patch Changes

- Updated dependencies [4f9fab2]
  - @hot-updater/cli-tools@0.35.8
  - @hot-updater/plugin-core@0.35.8

## 0.35.7

### Patch Changes

- @hot-updater/cli-tools@0.35.7
- @hot-updater/plugin-core@0.35.7

## 0.35.6

### Patch Changes

- @hot-updater/cli-tools@0.35.6
- @hot-updater/plugin-core@0.35.6

## 0.35.5

### Patch Changes

- @hot-updater/cli-tools@0.35.5
- @hot-updater/plugin-core@0.35.5

## 0.35.4

### Patch Changes

- @hot-updater/cli-tools@0.35.4
- @hot-updater/plugin-core@0.35.4

## 0.35.3

### Patch Changes

- @hot-updater/cli-tools@0.35.3
- @hot-updater/plugin-core@0.35.3

## 0.35.2

### Patch Changes

- @hot-updater/cli-tools@0.35.2
- @hot-updater/plugin-core@0.35.2

## 0.35.1

### Patch Changes

- @hot-updater/cli-tools@0.35.1
- @hot-updater/plugin-core@0.35.1

## 0.35.0

### Patch Changes

- @hot-updater/cli-tools@0.35.0
- @hot-updater/plugin-core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies [088f6c1]
  - @hot-updater/plugin-core@0.34.0
  - @hot-updater/cli-tools@0.34.0

## 0.33.2

### Patch Changes

- @hot-updater/cli-tools@0.33.2
- @hot-updater/plugin-core@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [a5c4467]
  - @hot-updater/plugin-core@0.33.1
  - @hot-updater/cli-tools@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [070a86f]
- Updated dependencies [e914f56]
  - @hot-updater/cli-tools@0.33.0
  - @hot-updater/plugin-core@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [4e6d2ec]
  - @hot-updater/cli-tools@0.32.0
  - @hot-updater/plugin-core@0.32.0

## 0.31.4

### Patch Changes

- @hot-updater/cli-tools@0.31.4
- @hot-updater/plugin-core@0.31.4

## 0.31.3

### Patch Changes

- @hot-updater/cli-tools@0.31.3
- @hot-updater/plugin-core@0.31.3

## 0.31.2

### Patch Changes

- @hot-updater/cli-tools@0.31.2
- @hot-updater/plugin-core@0.31.2

## 0.31.1

### Patch Changes

- @hot-updater/cli-tools@0.31.1
- @hot-updater/plugin-core@0.31.1

## 0.31.0

### Patch Changes

- @hot-updater/cli-tools@0.31.0
- @hot-updater/plugin-core@0.31.0

## 0.30.12

### Patch Changes

- @hot-updater/cli-tools@0.30.12
- @hot-updater/plugin-core@0.30.12

## 0.30.11

### Patch Changes

- @hot-updater/cli-tools@0.30.11
- @hot-updater/plugin-core@0.30.11

## 0.30.10

### Patch Changes

- @hot-updater/cli-tools@0.30.10
- @hot-updater/plugin-core@0.30.10

## 0.30.9

### Patch Changes

- @hot-updater/cli-tools@0.30.9
- @hot-updater/plugin-core@0.30.9

## 0.30.8

### Patch Changes

- Updated dependencies [6019156]
  - @hot-updater/cli-tools@0.30.8
  - @hot-updater/plugin-core@0.30.8

## 0.30.7

### Patch Changes

- Updated dependencies [03fd179]
  - @hot-updater/cli-tools@0.30.7
  - @hot-updater/plugin-core@0.30.7

## 0.30.6

### Patch Changes

- @hot-updater/cli-tools@0.30.6
- @hot-updater/plugin-core@0.30.6

## 0.30.5

### Patch Changes

- @hot-updater/cli-tools@0.30.5
- @hot-updater/plugin-core@0.30.5

## 0.30.4

### Patch Changes

- @hot-updater/cli-tools@0.30.4
- @hot-updater/plugin-core@0.30.4

## 0.30.3

### Patch Changes

- @hot-updater/cli-tools@0.30.3
- @hot-updater/plugin-core@0.30.3

## 0.30.2

### Patch Changes

- @hot-updater/cli-tools@0.30.2
- @hot-updater/plugin-core@0.30.2

## 0.30.1

### Patch Changes

- @hot-updater/cli-tools@0.30.1
- @hot-updater/plugin-core@0.30.1

## 0.30.0

### Minor Changes

- 83c01c8: fix: keep target cohorts additive to rollout

### Patch Changes

- Updated dependencies [83c01c8]
  - @hot-updater/cli-tools@0.30.0
  - @hot-updater/plugin-core@0.30.0

## 0.29.8

### Patch Changes

- @hot-updater/cli-tools@0.29.8
- @hot-updater/plugin-core@0.29.8

## 0.29.7

### Patch Changes

- @hot-updater/cli-tools@0.29.7
- @hot-updater/plugin-core@0.29.7

## 0.29.6

### Patch Changes

- Updated dependencies [80cce61]
  - @hot-updater/cli-tools@0.29.6
  - @hot-updater/plugin-core@0.29.6

## 0.29.5

### Patch Changes

- Updated dependencies [52208f4]
  - @hot-updater/plugin-core@0.29.5
  - @hot-updater/cli-tools@0.29.5

## 0.29.4

### Patch Changes

- @hot-updater/cli-tools@0.29.4
- @hot-updater/plugin-core@0.29.4

## 0.29.3

### Patch Changes

- Updated dependencies [d1ffb83]
  - @hot-updater/plugin-core@0.29.3
  - @hot-updater/cli-tools@0.29.3

## 0.29.2

### Patch Changes

- Updated dependencies [2a1bc80]
  - @hot-updater/cli-tools@0.29.2
  - @hot-updater/plugin-core@0.29.2

## 0.29.1

### Patch Changes

- c283b5f: feat: add resetCache option to `bare` and `expo` plugin configurations
  - @hot-updater/cli-tools@0.29.1
  - @hot-updater/plugin-core@0.29.1

## 0.29.0

### Minor Changes

- a935992: feat: Rollout feature with control from 1% to 100%

### Patch Changes

- d0fe908: fix(console): rebuild copied bundles with fresh uuidv7 ids
- Updated dependencies [a935992]
- Updated dependencies [d0fe908]
  - @hot-updater/plugin-core@0.29.0
  - @hot-updater/cli-tools@0.29.0

## 0.28.0

### Patch Changes

- @hot-updater/cli-tools@0.28.0
- @hot-updater/plugin-core@0.28.0

## 0.27.1

### Patch Changes

- @hot-updater/cli-tools@0.27.1
- @hot-updater/plugin-core@0.27.1

## 0.27.0

### Minor Changes

- 81f9437: feat(android): for safe reloading, Android reloads the process (#869)

### Patch Changes

- Updated dependencies [81f9437]
  - @hot-updater/cli-tools@0.27.0
  - @hot-updater/plugin-core@0.27.0

## 0.26.2

### Patch Changes

- @hot-updater/cli-tools@0.26.2
- @hot-updater/plugin-core@0.26.2

## 0.26.1

### Patch Changes

- @hot-updater/cli-tools@0.26.1
- @hot-updater/plugin-core@0.26.1

## 0.26.0

### Patch Changes

- @hot-updater/cli-tools@0.26.0
- @hot-updater/plugin-core@0.26.0

## 0.25.14

### Patch Changes

- @hot-updater/cli-tools@0.25.14
- @hot-updater/plugin-core@0.25.14

## 0.25.13

### Patch Changes

- @hot-updater/cli-tools@0.25.13
- @hot-updater/plugin-core@0.25.13

## 0.25.12

### Patch Changes

- @hot-updater/cli-tools@0.25.12
- @hot-updater/plugin-core@0.25.12

## 0.25.11

### Patch Changes

- @hot-updater/cli-tools@0.25.11
- @hot-updater/plugin-core@0.25.11

## 0.25.10

### Patch Changes

- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10

## 0.25.9

### Patch Changes

- Updated dependencies [6b22072]
  - @hot-updater/plugin-core@0.25.9
  - @hot-updater/cli-tools@0.25.9

## 0.25.8

### Patch Changes

- @hot-updater/cli-tools@0.25.8
- @hot-updater/plugin-core@0.25.8

## 0.25.7

### Patch Changes

- @hot-updater/cli-tools@0.25.7
- @hot-updater/plugin-core@0.25.7

## 0.25.6

### Patch Changes

- @hot-updater/cli-tools@0.25.6
- @hot-updater/plugin-core@0.25.6

## 0.25.5

### Patch Changes

- @hot-updater/cli-tools@0.25.5
- @hot-updater/plugin-core@0.25.5

## 0.25.4

### Patch Changes

- Updated dependencies [8c83ff2]
  - @hot-updater/cli-tools@0.25.4
  - @hot-updater/plugin-core@0.25.4

## 0.25.3

### Patch Changes

- @hot-updater/cli-tools@0.25.3
- @hot-updater/plugin-core@0.25.3

## 0.25.2

### Patch Changes

- @hot-updater/cli-tools@0.25.2
- @hot-updater/plugin-core@0.25.2

## 0.25.1

### Patch Changes

- @hot-updater/cli-tools@0.25.1
- @hot-updater/plugin-core@0.25.1

## 0.25.0

### Patch Changes

- @hot-updater/cli-tools@0.25.0
- @hot-updater/plugin-core@0.25.0

## 0.24.7

### Patch Changes

- 294e324: fix: update babel plugin path in documentation and plugin files
- Updated dependencies [294e324]
  - @hot-updater/cli-tools@0.24.7
  - @hot-updater/plugin-core@0.24.7

## 0.24.6

### Patch Changes

- a8a27e2: fix(bare): lookup hermesc path for React Native 0.82+
- Updated dependencies [9d7b6af]
  - @hot-updater/cli-tools@0.24.6
  - @hot-updater/plugin-core@0.24.6

## 0.24.5

### Patch Changes

- @hot-updater/cli-tools@0.24.5
- @hot-updater/plugin-core@0.24.5

## 0.24.4

### Patch Changes

- Updated dependencies [7ed539f]
  - @hot-updater/plugin-core@0.24.4
  - @hot-updater/cli-tools@0.24.4

## 0.24.3

### Patch Changes

- @hot-updater/cli-tools@0.24.3
- @hot-updater/plugin-core@0.24.3

## 0.24.2

### Patch Changes

- @hot-updater/cli-tools@0.24.2
- @hot-updater/plugin-core@0.24.2

## 0.24.1

### Patch Changes

- @hot-updater/cli-tools@0.24.1
- @hot-updater/plugin-core@0.24.1

## 0.24.0

### Patch Changes

- @hot-updater/cli-tools@0.24.0
- @hot-updater/plugin-core@0.24.0

## 0.23.1

### Patch Changes

- @hot-updater/cli-tools@0.23.1
- @hot-updater/plugin-core@0.23.1

## 0.23.0

### Patch Changes

- @hot-updater/plugin-core@0.23.0
- @hot-updater/cli-tools@0.23.0

## 0.22.2

### Patch Changes

- @hot-updater/cli-tools@0.22.2
- @hot-updater/plugin-core@0.22.2

## 0.22.1

### Patch Changes

- @hot-updater/cli-tools@0.22.1
- @hot-updater/plugin-core@0.22.1

## 0.22.0

### Patch Changes

- @hot-updater/cli-tools@0.22.0
- @hot-updater/plugin-core@0.22.0

## 0.21.15

### Patch Changes

- @hot-updater/cli-tools@0.21.15
- @hot-updater/plugin-core@0.21.15

## 0.21.14

### Patch Changes

- @hot-updater/cli-tools@0.21.14
- @hot-updater/plugin-core@0.21.14

## 0.21.13

### Patch Changes

- @hot-updater/cli-tools@0.21.13
- @hot-updater/plugin-core@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies [5c4b98e]
  - @hot-updater/plugin-core@0.21.12
  - @hot-updater/cli-tools@0.21.12

## 0.21.11

### Patch Changes

- e2b67d7: fix(cli-tools): esm only package bundle
- Updated dependencies [d6c3a65]
- Updated dependencies [e2b67d7]
  - @hot-updater/cli-tools@0.21.11
  - @hot-updater/plugin-core@0.21.11

## 0.21.10

### Patch Changes

- @hot-updater/cli-tools@0.21.10
- @hot-updater/plugin-core@0.21.10

## 0.21.9

### Patch Changes

- Updated dependencies [aa399a6]
  - @hot-updater/plugin-core@0.21.9
  - @hot-updater/cli-tools@0.21.9

## 0.21.8

### Patch Changes

- Updated dependencies [3fe8c81]
  - @hot-updater/plugin-core@0.21.8
  - @hot-updater/cli-tools@0.21.8

## 0.21.7

### Patch Changes

- Updated dependencies [2b408f2]
  - @hot-updater/plugin-core@0.21.7

## 0.21.6

### Patch Changes

- @hot-updater/plugin-core@0.21.6

## 0.21.5

### Patch Changes

- @hot-updater/plugin-core@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies [5d3070a]
  - @hot-updater/plugin-core@0.21.4

## 0.21.3

### Patch Changes

- @hot-updater/plugin-core@0.21.3

## 0.21.2

### Patch Changes

- @hot-updater/plugin-core@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies [7b7bc48]
  - @hot-updater/plugin-core@0.21.1

## 0.22.0

### Minor Changes

- 036f8f0: feat: support `@hot-updater/server` for self-hosted (WIP)

### Patch Changes

- Updated dependencies [610b2dd]
- Updated dependencies [afb084b]
- Updated dependencies [036f8f0]
  - @hot-updater/plugin-core@0.22.0

## 0.20.15

### Patch Changes

- Updated dependencies [526a5ba]
- Updated dependencies [ddf6f2c]
  - @hot-updater/plugin-core@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies [a61fa0e]
  - @hot-updater/plugin-core@0.20.14

## 0.20.13

### Patch Changes

- @hot-updater/plugin-core@0.20.13

## 0.20.12

### Patch Changes

- @hot-updater/plugin-core@0.20.12

## 0.20.11

### Patch Changes

- Updated dependencies [cb9c05b]
  - @hot-updater/plugin-core@0.20.11

## 0.20.10

### Patch Changes

- @hot-updater/plugin-core@0.20.10

## 0.20.9

### Patch Changes

- @hot-updater/plugin-core@0.20.9

## 0.20.8

### Patch Changes

- Updated dependencies [ad7c999]
  - @hot-updater/plugin-core@0.20.8

## 0.20.7

### Patch Changes

- a92992c: chore(tsdown): failOnWarn true
- Updated dependencies [a92992c]
  - @hot-updater/plugin-core@0.20.7

## 0.20.6

### Patch Changes

- Updated dependencies [6a905d8]
  - @hot-updater/plugin-core@0.20.6

## 0.20.5

### Patch Changes

- @hot-updater/plugin-core@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies [5314b31]
- Updated dependencies [711392b]
  - @hot-updater/plugin-core@0.20.4

## 0.20.3

### Patch Changes

- Updated dependencies [e63056a]
  - @hot-updater/plugin-core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [0e78fb0]
  - @hot-updater/plugin-core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies [a3a4a28]
  - @hot-updater/plugin-core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [bc8e23d]
  - @hot-updater/plugin-core@0.20.0

## 0.19.10

### Patch Changes

- Updated dependencies [2bc52e8]
  - @hot-updater/plugin-core@0.19.10

## 0.19.9

### Patch Changes

- @hot-updater/plugin-core@0.19.9

## 0.19.8

### Patch Changes

- @hot-updater/plugin-core@0.19.8

## 0.19.7

### Patch Changes

- @hot-updater/plugin-core@0.19.7

## 0.19.6

### Patch Changes

- Updated dependencies [657a10e]
  - @hot-updater/plugin-core@0.19.6

## 0.19.5

### Patch Changes

- 40d28c2: bump rnef
- Updated dependencies [40d28c2]
  - @hot-updater/plugin-core@0.19.5

## 0.19.4

### Patch Changes

- Updated dependencies [0ddc955]
  - @hot-updater/plugin-core@0.19.4

## 0.19.3

### Patch Changes

- Updated dependencies [0c0ab1d]
  - @hot-updater/plugin-core@0.19.3

## 0.19.2

### Patch Changes

- @hot-updater/plugin-core@0.19.2

## 0.19.1

### Patch Changes

- @hot-updater/plugin-core@0.19.1

## 0.19.0

### Minor Changes

- 886809d: fix(babel): make sure the backend can handle channel changes for a bundle and still receive updates correctly

### Patch Changes

- Updated dependencies [886809d]
  - @hot-updater/plugin-core@0.19.0

## 0.18.5

### Patch Changes

- Updated dependencies [494ce31]
  - @hot-updater/plugin-core@0.18.5

## 0.18.4

### Patch Changes

- @hot-updater/plugin-core@0.18.4

## 0.18.3

### Patch Changes

- @hot-updater/plugin-core@0.18.3

## 0.18.2

### Patch Changes

- Updated dependencies [437c98e]
  - @hot-updater/plugin-core@0.18.2

## 0.18.1

### Patch Changes

- @hot-updater/plugin-core@0.18.1

## 0.18.0

### Patch Changes

- Updated dependencies [73ec434]
  - @hot-updater/plugin-core@0.18.0
