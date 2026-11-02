# @hot-updater/apple-helper

## 1.2.0-rc.13

### Minor Changes

- a1ae453: Preview a pull request through TestFlight internal testing or Google Play's internal track, with the preview action's `ios-submit: testflight` and `android-submit: play-internal` on a sandbox scheme. Nothing changes for a preview that sets neither.
  - The store build lives on the sandbox scheme's channel, so pull requests with the same fingerprint share it, with no new upload. The bundle deploys to the pull request's channel.
  - The comment shows the store's link and state in place of **Download**. New outputs: `android-store-url`, `ios-store-url`, `android-store-state`, `ios-store-state`, and `store` in `previews`.
  - `native-build find --store-status` asks the store for a submitted build's state. A TestFlight build near its expiry, or a Google Play build a newer release replaced, gets a new build.
  - `native-build ios --testflight-group <name> --what-to-test <text>` adds a sandbox build to an internal TestFlight group and sets its What to Test. An external group stops the build before it starts. `native-build testflight-group <id> <group> --scheme <scheme>` adds a sandbox build already on TestFlight to an internal group, as a reused preview does.
  - A sandbox `.aab`'s version code follows Google Play, as a sandbox `.ipa`'s build number follows App Store Connect, and a cached sandbox build the store may already hold gets a new number.
  - The Console's Install card leads with the store for a build a store took, in place of its QR code.

- 20006f2: Add sandbox builds: `sandbox: true` on a `nativeBuild` scheme builds the app with a native layer for testing, which no other build compiles. `@hot-updater/react-native` gets no new API and no new bridge method. See the Sandbox builds guide.
  - iOS: the layer's sources stay excluded unless the CLI's build xcconfig brings them back, and the CLI patches the archive's Info.plist before the export: a dedicated URL scheme and the default channel `sandbox-<scheme>`. The bundle ID stays what Xcode builds: the store app's by default, or a separate configuration's, which `bundleIdentifier` must name. The `.ipa` is for TestFlight internal testing only: the CLI checks it before the upload and reads `buildAudienceType` after it. A closed version train raises the sandbox build's version under the fingerprint strategy, and stops with a next step under `appVersion`.
  - A normal build excludes the layer again over a scheme's own `xcconfig`, which would otherwise replace the podspec's exclusion.
  - Android: `-PhotUpdaterSandbox=<scheme>` attaches `src/sandbox`, and a CLI-written init script adds `.sandbox` to the application ID and a manifest overlay for the channel. No project file changes. AGP 9's default DSL and a project's own build type manifest are refused.
  - Registry: the channel `sandbox-<scheme>` is reserved, with no new column. Before a build is tracked or uploaded, and in `native-build import`, the CLI reads the artifact: a sandbox build must hold the layer and embed a normal build's fingerprint, and a normal build must hold none of it.
  - `hot-updater doctor` reports what a sandbox scheme can't build with, a `google-services.json` with no client for the real application ID, and what no sandbox build has been tested with.
  - Fix a repeat `assembleRelease` failing with `it is internal in file` on Kotlin 2: every build's `MIN_BUNDLE_ID` changes a generated Java class, so the SDK's module no longer compiles Kotlin incrementally.

### Patch Changes

- ad99046: Install an ad hoc IPA on an iPhone from the Console, and register iPhones from the CLI.
  - A build's page on an iPhone checks whether the IPA includes that phone, reading its `Info.plist` and provisioning profiles from storage with HTTP Range requests. It offers "Check this iPhone", then "Install" or "Not in this build", with "Install anyway" second. A storage that answers Range with the whole file shows "Installation details unavailable", and nothing downloads.
  - "Check this iPhone" installs a UDID-only profile. The phone lands on a page, which takes no session and reads nothing, with its UDID, one command to send a maintainer, and a copy button. The UDID stays in the phone's `localStorage`.
  - Install opens `itms-services` on `/_hot-updater/native-builds/{id}/manifest.plist?t=`, which verifies its download token before any read and mints nothing. An Install link lasts about an hour.
  - `native-build devices add --udid <UDID> --name <name>` (`--udid` repeats) registers iPhones in App Store Connect, each at most once, and `native-build devices list` reads them back. The Console never holds an Apple key.
  - `native-build ios` prints how many devices the `.ipa` lists, and with `--udid` whether each is included. A sandbox scheme can export with `release-testing`.
  - A pull request preview's QR code of an IPA holds the build's page, through `/_hot-updater/native-builds/qr?target=page`, which stays anonymous and reads nothing.
  - `@hot-updater/protocol/native-artifact` adds `readIpaInstallInfo`, `readProfileServiceUdid` and `normalizeIosUdid`. Its plist parser now reads crafted XML in linear time.
  - An ad hoc export in CI signs in the build's own keychain, and only its development certificates are revoked.
  - An iOS build's output and cache hold only the `.ipa` of its export. Xcode's `Packaging.log`, which holds the API key's bearer token for 20 minutes, no longer reaches `.hot-updater/output`. Build logs mask any JSON Web Token.

- 64fe8d8: Download and install a tracked native build from the CLI.
  - `hot-updater native-build download <id> [-o path]` writes the artifact through the config's storage (`storage.get`), with no Console and no download URL.
  - `hot-updater native-build install <id> [--simulator <udid>] [--device <serial>]` downloads a simulator `.app` or `.apk`, installs it on a booted simulator or a connected Android device, and opens the app the artifact names, so a sandbox build's `.sandbox` application ID works the same way.
  - `native-build find --json` adds `downloadUrl`, the storage's `getDownloadUrl` result or `null`. Only a Console signs a signed link: the CLI doesn't hold its secret.
  - The Console's Install card shows `native-build install` for a simulator build, in place of the `xcrun simctl` commands.

- 134d970: Keep the iOS sandbox layer out of a build that overrides the pod's excluded files.
  - An app's own `EXCLUDED_SOURCE_FILE_NAMES` replaced the only thing keeping the layer out, so a plain `xcodebuild` could show the sandbox screen. Its sources now compile to nothing without a condition only Hot Updater's build of a sandbox scheme sets, and it starts only with the `Info.plist` key that build writes
  - On Android, a project that gave every library a build type or flavor named `sandbox` compiled the layer in, unused. Those source sets now stay empty
  - A scheme's `xcconfig` that sets `SWIFT_ACTIVE_COMPILATION_CONDITIONS` or `GCC_PREPROCESSOR_DEFINITIONS` with a condition such as `[config=Release]` is now refused for a sandbox scheme, since it would outrank the build's own

- Updated dependencies [b54eddc]
- Updated dependencies [ad99046]
- Updated dependencies [20006f2]
- Updated dependencies [3d95e55]
- Updated dependencies [ef790db]
  - @hot-updater/plugin-core@1.2.0-rc.13
  - @hot-updater/cli-tools@1.2.0-rc.13
  - @hot-updater/protocol@1.2.0-rc.13

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

- 41444fa: `native-build ios` shows CocoaPods' error when `pod install` fails: its `[!]` lines and last lines, without curl's download progress, with the path to the full log in `.hot-updater/log`.
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

- 21cfeec: `native-build ios` and `native-build android` print a few lines with live progress. One `Preparing` line covers the prebuild, the app version or fingerprint, codegen, Ruby gems, and pods, showing the current sub-step, and ends as `Prepared iOS 1.7.0 · prebuild · codegen · pods` with its duration. The cache result is one line with its reason, such as `Cache miss · engine changed`. Archive, export, and Gradle each show one live line with the phase read from the tool's output (`Compiling React-Core · 412 files`, `Linking`, `Signing`, `Bundling JavaScript`, or Gradle's current task) and the elapsed time, and each ends as one line with its duration. Registering the build and uploading it to TestFlight or Google Play are also one line each. The run ends with a summary: the artifact's path and size, the version and build number, the MIN_BUNDLE_ID, the channel, the total time, and the build log. The xcodebuild or Gradle command line, the full native build key, and what changed since the cached build go to the build log, so credential file paths stay off the terminal. iOS writes the archive and its export to one log. In CI and without a terminal, no spinner runs: each finished step prints one line. A failure ends its step's line as failed, then prints up to 20 of the tool's error lines (an export's errors with the lines that explain them), or else its last 15 lines, and the log's path on stderr. A failed `pod install`, `bundle install`, or codegen names the command and the last lines of its output. `xcbeautify` is no longer used. `expo prebuild` now reports done after it finishes, not before it starts. `@hot-updater/cli-tools` exports `startStep`, `createStep`, `withStep`, `failActiveStep`, `formatDuration`, and `withDuration`; while a step runs, `p` spinners and info lines become its detail, and other logs print after its line. `BuildLogger` takes a `createPhaseReader` instead of `importantLogPatterns` and `progressStages`.
- Updated dependencies [8a440e3]
- Updated dependencies [2e3f250]
- Updated dependencies [21cfeec]
- Updated dependencies [c463534]
- Updated dependencies [5358377]
  - @hot-updater/cli-tools@1.2.0-rc.8
  - @hot-updater/plugin-core@1.2.0-rc.8

## 1.2.0-rc.7

### Patch Changes

- f3989de: rc.6 QA fixes. A CI iOS build revokes only the signing certificates Xcode created in its keychain, never the Apple CA intermediates imported beside them, and a certificate it can't revoke is named on one line with its serial on the next, then the page to revoke it. When Apple's Program License Agreement isn't accepted, the build failure, TestFlight uploads, the certificate revocation, and key issuing say the Account Holder must accept it at developer.apple.com/account. `secrets import` takes the env file to read, `.env.hotupdater` by default, reads only that file, and lists the names it stored one per line. A secrets adapter that can't be read names the secret and the adapter above its own error. `secrets issue asc-api-key` and `apple login` name the team the key was issued in.
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

- ebb223a: `apple login` and `google-play login` report a key already stored, or set by the environment, and exit 0 without a terminal too, as in CI; only a sign-in needs one. Doctor's outdated-server advice is one line and init's command, named once: when the database also has migrations to run, the schema check names it instead. `agent infra upgrade` names `upgrades/README.md` once, and each file relative to the templates' directory. `native-build --dry-run` ends with one line, such as `Dry run: not recorded or submitted to TestFlight`, after the build's block, without repeating its rows; the app version and fingerprint steps read `iOS app version 1.7.0`, and the `.app file created` line is gone. `keys generate` prints its keys under a `Keys generated` heading. `--json` output is unchanged.
- @hot-updater/cli-tools@1.2.0-rc.4
  - @hot-updater/plugin-core@1.2.0-rc.4

## 1.2.0-rc.3

### Patch Changes

- 3c00e7a: The commands new in 1.2 print short output that fits an 80-column terminal: one idea per line, `Label  value` rows padded to a common width, paths with `~` or relative to the project and shortened in the middle, and bare highlighted commands without backticks. A result with nothing to do, such as `apple login` with a key already stored, states the result and stops; a next step is printed only when you have to act. `apple login` and `google-play login` name the one place they found the key. Doctor prints each issue and its resolution as one entry, a sentence per line. `--json` output is unchanged.
- Updated dependencies [3c00e7a]
  - @hot-updater/cli-tools@1.2.0-rc.3
  - @hot-updater/plugin-core@1.2.0-rc.3

## 1.2.0-rc.2

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.2
  - @hot-updater/plugin-core@1.2.0-rc.2

## 1.2.0-rc.1

### Patch Changes

- cd5fa07: `hot-updater native-build ios` removes the temporary directories it builds in, which it used to leave in the system's temporary directory, 10 GB or more each.
  - The Xcode DerivedData of a simulator build, which can take 10 GB or more, is removed once the `.app` is copied out of it, whether the build succeeds or fails.
  - The `.xcarchive` and the export are written straight to the build directory, instead of temporary directories copied into it.
  - The build directory is removed once its artifact is copied to the output path, and a failed build removes it, and every other directory it used, right away.
  - A build interrupted with Ctrl+C, or ended by a signal, removes them too.
  - The build log in `.hot-updater/log` stays where it is, after a failed build too.

- @hot-updater/cli-tools@1.2.0-rc.1
  - @hot-updater/plugin-core@1.2.0-rc.1

## 1.2.0-rc.0

### Minor Changes

- 6276804: Sign in with your Apple Account to issue the App Store Connect API key. An iOS build that needs a key for `signing.ascApiKey` or `--submit testflight` and finds none asks for the Apple Account, its password (masked), and the two-factor code in Hot Updater's own prompts in a terminal, issues a team key named `hot-updater <date>` with the Admin role through asc, the open-source App Store Connect CLI, stores it through the config's `secrets` adapter, `localSecrets()` by default, which keeps it in `~/.hot-updater/secrets/<project-key>/` on this machine, and continues; `hot-updater secrets issue asc-api-key [name]`, or its shortcut `hot-updater apple login`, which takes no options or arguments, does the same ahead of time, the only command that signs in before a build. It keeps a key the adapter or the environment already provides, printing where it is and its key ID. Keys are per machine: on one without a key, it says before signing in that it will issue a new key, and how to share one key across machines instead; after issuing, it names the App Store Connect page where you revoke the keys no machine uses anymore. `--replace` issues a new key, stores it, and names the old key ID with where to revoke it in App Store Connect, never revoking it itself, since CI may still use it. `hot-updater secrets put` only imports a key you have (`--p8`, `--key-id`, `--issuer-id`) and points to `apple login` without them. Builds and `apple login` without a terminal or in CI never sign in: builds use the stored key and refuse with `npx hot-updater apple login` when there is none, or `npx hot-updater secrets issue asc-api-key <name>` for a key named otherwise. Hot Updater keeps no Apple session, so there is no logout: each sign-in ends naming the key it stored and where. Only the issued key is kept: asc's session, config, and the `.p8` live in a temporary directory that is deleted, and a key that surely was not stored is revoked again.
- d7f02a6: Native builds run in CI without signing in. The CLI treats a run as CI when `CI` is set or it has no terminal: it asks nothing there, even on a terminal a runner allocates, and never starts an Apple or Google sign-in. `native-build ios` and `native-build android` resolve every credential they sign and upload with before the build adapter's prebuild, so a missing one fails in seconds; the error names the `secrets` adapter and where it keeps the credential, the command that stores it once (`apple login` or `google-play login` for a key Hot Updater issues, `secrets put` for a keystore), and the environment variables that provide it instead. In CI, an iOS build that signs with an App Store Connect API key archives and exports in a keychain of its own, restores the runner's keychains afterwards, and revokes the development certificates Xcode created in it, so runners that start empty don't pile up certificates. The new `actions/native-build` GitHub Action runs `native-build <platform> --submit` with the job's environment, its `submit` input naming the store, and the "Build and upload from CI" guide has a complete workflow that maps GitHub Actions secrets to the job's environment. When the build fails, the action uploads the CLI's build log as the `hot-updater-build-log-<platform>-<scheme>` artifact and sets it as the `build-log` output.
- 79c81f6: `hot-updater native-build ios` and `native-build android` reuse a build instead of building again when nothing that can change the artifact changed. After the build adapter's prebuild, each build computes a native build key (`nbk1:` and a SHA-256) of every file of the git repository, the ignored native project files, `.env*` files, the install state and installed native packages it reads, what Expo and React Native CLI autolinking link (the config it prints, without this machine's directories, and each linked package file by file, wherever it is, with the ignored files of the repository's packages), the scheme's settings and files, the channel and fingerprint or app version, the signing identity (never a password or key), the toolchain, and the environment variables the build reads. A build the registry tracks with that key, whose artifact storage holds, is copied or downloaded to the output path, and nothing is built, tracked, or uploaded; else this machine's cached build with the key, such as a `--dry-run`'s, is tracked with its own min bundle ID; else the CLI builds and says what changed since the cached build. The CLI keeps one build per platform and scheme under `cacheDir`. A build no key can cover (Debug, outside git, autolinking that can't run, no `Podfile.lock` or `Package.resolved`, a dynamic Gradle version without a lockfile, environment reads by a computed name, device-list export methods, uninstalled provisioning profiles) always builds, and says why. `--no-cache` builds anyway and still records the key; `--submit` skips a reused build the store already has (`findTestFlightBuild` in `@hot-updater/apple-helper`, `findPlayInternalRelease` and `readBuiltVersionCode` in `@hot-updater/android-helper`); `--json` adds `cache: { hit, key, uncacheable, changed }`. The key is separate from the fingerprint, which keeps deciding which OTA updates a build takes, and `native-build find` keeps finding builds by scope.

  Core's `native_builds` table has the nullable `build_key` column and the `byBuildKey` index, in the managed `0002_hot-updater_1.2.0.sql` migrations and the PostgreSQL schema. `NativeBuildRegistration` takes `buildKey`, `NativeBuildRow` has `build_key`, and `findNativeBuild(scope, { buildKey })` finds the newest build of a scope with a key in one read, also through `GET /native-builds/latest?buildKey=` and `standaloneRepository`, which reads a server's answer without the key as no build.

- 4d8e0d2: Every native build `hot-updater native-build ios|android` makes is tracked in Hot Updater's native build registry, with no flag to opt out.
  - Core's schema moves to 1.2.0 with the `native_builds` table, in the managed D1 and Supabase `0002_hot-updater_1.2.0.sql` migrations; `hot-updater init`, run again with its saved inputs, applies it. The table changes no existing one: its references to `channels` and `bundles` keep no counters.
  - Before it builds, and before any Apple or Google sign-in, the CLI checks read-only that it can track the build: it asks the registry for the build's scope (for its newest build when the build adapter's prebuild has yet to generate the native project), and reads back (`exists`) the artifact of a build the registry already tracks there; when the database or the storage can't be reached, it stops in seconds naming which, and builds nothing. A Debug build, which loads its JavaScript from Metro and has no built-in bundle, is not tracked: the CLI says so before it builds, and `--json` reports `registration: { skipped: "debug" }`. When tracking fails after the build, the CLI exits with the artifact's path and submits it to no store.
  - `--dry-run` builds but records and submits nothing, as `npm publish --dry-run` does: it runs the checks read-only, reads the store key `--submit` would use without signing in or issuing one, keeps the artifact on this machine, and prints what it would have recorded and where it would have submitted. A missing store key is reported, the build still runs, and the command exits 1 at the end. With `--json`, the last line has `dryRun: true`, `registration: { skipped: "dry-run" }`, and `submission: { skipped: "dry-run", destination }`.
  - Tracking takes the JavaScript bundle a release build compiled in out of the artifact (`assets/index.android.bundle` in an `.apk`, `base/assets/index.android.bundle` in an `.aab`, `main.jsbundle` in an `.ipa` or `.app`), uploads the artifact to `native-builds/<platform>/<id>/` in the config's storage (a simulator `.app` as one `.app.zip`), uploads that bundle as the build's built-in bundle, a bundle whose ID is the MIN_BUNDLE_ID and whose manifest lists only that file at an OTA bundle's asset path, then registers both. It uses the config's `database` and `storage`, as deploy does.
  - A tracked build records the build number its artifact reports, `build_number` (`CFBundleVersion` from the app's Info.plist, `versionCode` read with `aapt2`), which the Console shows; registrations without it, as from an earlier CLI, store null.
  - A tracked build records the store track it was submitted to: `native_builds` has nullable `submitted_to` (`testflight` or `play-internal`), `submitted_at_ms`, and `submitted_version`, the store's version and build number. Core's `recordNativeBuildSubmission(id, { destination, version })` writes them in one read and one write, refusing another platform's store, and answers null for an unknown build; the admin API serves it at `POST /native-builds/:id/submission`, and `standaloneRepository` maps it.
  - Core's API adds `registerNativeBuild`, which writes the build and its built-in bundle's row in one transaction, `findNativeBuild`, the newest build of a platform, channel, and fingerprint or exact app version in one indexed read, and `listNativeBuilds`. The admin API serves them at `POST /native-builds`, `GET /native-builds/latest`, and `GET /native-builds`, and `standaloneRepository` maps them; a server without these routes answers 404, which the CLI reports as a server to upgrade.
  - A built-in bundle is no OTA bundle: no release publishes it, the bundle totals leave it out, core refuses to delete it or to release it, and `storage prune` keeps its files and the artifact. Update checks and artifact responses do not change.
  - `azureBlobStorage` and `firebaseStorage` stream uploads instead of reading them into memory.
  - `@hot-updater/android-helper` and `@hot-updater/apple-helper` export `extractBuiltInBundle`, and `@hot-updater/apple-helper` exports `archiveAppBundle`.

- ed37acf: `hot-updater native-build ios` and `hot-updater native-build android` build native apps, without `EXPERIMENTAL`: `native-build <platform> [-s <scheme>] [-o <path>] [--submit testflight|play-internal] [--dry-run] [--json]`, beside `native-build find`, `native-build delete`, and `native-build import`. They replace the experimental `build:ios` and `build:android`; `run:ios` and `run:android` are removed, with no alias: install the artifact (`xcrun simctl install`, `adb install`) or use your framework's run command. Without `--scheme`, the build asks for the scheme at a terminal, and in CI or without a terminal stops with the schemes to pass. A build returns and prints the artifact (`.apk`, `.aab`, `.ipa`, or simulator `.app`) with the values compiled into it: the MIN_BUNDLE_ID, the fingerprint hash or app version, and the default channel (the app version and channel are read from the built artifact: the app's Info.plist on iOS, and with the SDK's `aapt2` the merged manifest of the `.apk` or `.aab` on Android). The build adapter's `prebuild`, such as `expo prebuild`, now runs before the commands read the native projects. The CLI issues each MIN_BUNDLE_ID as the SDK's podspec script phase and Gradle task do, the UUIDv7 of the build's millisecond with zero random bits, stepped 1 ms forward past a bundle the registry already holds at it; a build whose MIN_BUNDLE_ID another build registered first, as one started in the same millisecond can, is refused when it is tracked, with an error that says so.

  `hot-updater native-build import <file> [-c <channel>] [--dry-run] [--json]` tracks an `.ipa`, `.aab`, `.apk`, or simulator `.app` (the directory or its `.app.zip`) built elsewhere, such as by another build service or an earlier release, as `native-build ios|android` tracks its own builds, with the build number it reports as the row's `build_number`, so OTAs deployed after it patch from its built-in bundle. It reads everything from the artifact: the platform, app version, build number, and app ID from the manifest or Info.plist, the channel the app reports (`production` without one), the MIN_BUNDLE_ID and the fingerprint from the string literals of the app's code (the dex files' string pool, or the Mach-O `__cstring` section of the executable or of HotUpdater's dynamic framework), and the built-in bundle. It prints what it read, then refuses an artifact without a built-in bundle (a Debug build), one built without `@hot-updater/react-native`'s build step (no MIN_BUNDLE_ID) or with several candidates, one without a fingerprint under the fingerprint strategy or without a comparable app version under the appVersion strategy, a channel given as a resource reference (unless `--channel` names the channel the app reports, as when its code sets one or it switches at runtime), and an artifact whose MIN_BUNDLE_ID is registered with another built-in bundle or scope, naming that native build. Importing the same build again succeeds and changes nothing, reporting `alreadyImported: true` under `--json`, so CI jobs can rerun. An app ID no `nativeBuild` scheme's `bundleIdentifier` or `applicationId` (by default its `packageName`) names is a warning. It then uploads the artifact and the built-in bundle and registers them with no build key and no commit; `--dry-run` reads and checks, and records nothing. The reader treats every artifact as untrusted input: it reads only the entries it needs through the zip's central directory, caps the directory, each entry it reads, and all it inflates, stops an entry that inflates past its declared size (a zip bomb), matches no absolute or `..` entry name and refuses a symbolic link or a doubled name among those it reads, writes nothing to disk by entry name, gives up after two minutes, and refuses a truncated or malformed archive, plist, or manifest as unreadable instead of crashing. `@hot-updater/protocol/native-artifact`, a subpath no app imports, exports the reader (`readNativeArtifact` over a `blobSource`, with no dependencies) and `checkNativeArtifact`.

  A `nativeBuild` scheme signs with a credential the CLI resolves while it builds: `signing: { keystore }` on Android passes an `android-keystore` to Gradle as the injected signing properties of release variants, and `signing: { ascApiKey }` on iOS signs device builds with automatic signing through an `asc-api-key`. Debug variants and simulator builds resolve nothing. With `signing.ascApiKey` and no `exportOptionsPlist`, an iOS device build exports for App Store Connect, and `native-build ios` refuses a device scheme with neither before it builds. The helpers' `minBundleId` and `credentials` are optional: without them, `buildAndroid` and `buildIos` issue a MIN_BUNDLE_ID of the build's millisecond (`createMinBundleId` from `@hot-updater/cli-tools`) and resolve signing credentials from the environment. `@hot-updater/android-helper` and `@hot-updater/apple-helper` no longer export `runAndroid`, `runIos`, or their device types. The build log in `.hot-updater/log` keeps the whole output of `xcodebuild` (also with `xcbeautify` installed, which now only formats the progress) or Gradle, through its last line. A failed build prints why on stderr, in `--json` mode too: `xcodebuild`'s `error:` lines and failed commands, or Gradle's `What went wrong` block, else the output's last 40 lines, then `Build log: <path>`, instead of the raw start of the tool's output; the helpers throw a `BuildFailedError` (`@hot-updater/cli-tools`) with the log's path and those lines.

- f017e61: The CLI reads secrets through the `secrets` adapter in `hot-updater.config.ts`, `localSecrets()` by default, which `init` writes: `secrets: localSecrets()`. `localSecrets()` reads a name from the environment, then from a JSON file on this machine, `~/.hot-updater/secrets/<project-key>/<name>.json`: a directory only your user can open (0700) holding files only your user can read (0600), in your home directory, so `rm -rf node_modules` keeps it and it is never committed. The project key is the project directory's name and a hash of its path, so each checkout has its own; `HOT_UPDATER_HOME` moves `~/.hot-updater`. `localSecrets({ path })` names the directory instead: `~` is the home directory, a relative path is the project's, and a directory in a git work tree must be one git ignores, or its first use fails. Keys Hot Updater issues after a sign-in, and credentials `secrets put` imports, go there, and the next build on this machine reads them with no step in between. With another adapter, builds read a credential it does not hold from the same default directory, where a key goes when the adapter stores nothing. `.env.hotupdater` stays the deploy-settings file managed `init` writes: Hot Updater never writes a key there.

  `localSecrets()` is the one built-in adapter, an export of `hot-updater` beside `defineConfig` and `secretEnv`, which also re-exports the `SecretsAdapter` and `SecretsContext` types from `@hot-updater/plugin-core`. The provider packages ship their cloud's store. `secretsManager({ region, prefix?, credentials?, endpoint? })` from `@hot-updater/aws` keeps each name as the AWS Secrets Manager secret `<prefix><name>` (`hot-updater/` by default) on the AWS SDK's default credential chain: GitHub Actions OIDC through `aws-actions/configure-aws-credentials` in CI, a profile or AWS SSO on your machine. `set` puts a new version, or creates the secret without tags; a missing secret reads as `undefined`, and a refused permission, expired credentials, or a secret scheduled for deletion fail with what to do. `secretManager({ projectId, prefix?, credentials? })` from `@hot-updater/firebase` keeps each name as the Google Cloud Secret Manager secret `<prefix><name>` (`hot-updater-` by default), read at `latest`, through the REST API and the `google-auth-library` firebase-admin already installs: Application Default Credentials on your machine, Workload Identity Federation through `google-github-actions/auth` in CI, or an access token. `set` adds a version, waits until `latest` resolves to it, and destroys only the versions it added before; a project without the Secret Manager API says to enable `secretmanager.googleapis.com`. Both load their SDK on the first read or write, so a config or server that only imports `s3Storage` or `firebaseStorage` never loads it, and mask every value and credential in the CLI's output. For another store, write an adapter: the docs have a short one for dotenvx (encrypted values committed to the repository), Bitwarden Secrets Manager, 1Password, and Infisical, each on the vendor's own SDK. `SecretsAdapter` is the contract: `get(names, { cwd })` reads names in one call, `undefined` for a name the store does not hold and a thrown error for any other failure, and the optional `set(name, value, { cwd })` and `describe(name)` store a value and say where it is.
  - Native build `signing.keystore` and `signing.ascApiKey` name a secret as `secret:<name>`, such as `"secret:release-keystore"`. A credential is one JSON value per name: `{"keyId","issuerId","p8"}` for an App Store Connect key, `{"keystore","storePassword","keyAlias","keyPassword"}` with the keystore in base64, and a Play service account's own JSON. `localSecrets()` reads a name from its environment variable first: a variable name as it is, such as `CLOUDFLARE_API_TOKEN`, and another name upper-cased after `HOT_UPDATER_`, such as `HOT_UPDATER_ASC_API_KEY` for `asc-api-key`, as a workflow maps a GitHub Actions secret. The `HOT_UPDATER_ASC_KEY*`, `HOT_UPDATER_ANDROID_KEYSTORE_*`, and `HOT_UPDATER_PLAY_SERVICE_ACCOUNT_*` variables still override each kind. Items a build asks for together are read in one `get`, file values are 0600 temporary files, and each value is masked in the CLI's output with every secret field of it; IDs, the key alias, and a service account's email stay readable.
  - `secretEnv([...names])` from `hot-updater` returns a function a config's adapters call for their deploy credentials: names set in the environment or `.env.hotupdater` win, the others come from the config's `secrets` adapter, and the values go only to the caller, never into `process.env`. With `localSecrets()`, every name must be set in the environment: its files hold only keys Hot Updater stores. It refuses variables that change how a process loads code, such as `NODE_OPTIONS`, `PATH`, `LD_*`, `DYLD_*`, `GIT_*`, `npm_config_*`, and the JVM's, Gradle's, Ruby's, Python's, and Perl's options, and those Hot Updater reads its credentials from, `HOT_UPDATER_HOME` included (`isReservedVariableName` in `@hot-updater/cli-tools`).
  - `hot-updater secrets put <name> --kind <asc-api-key|android-keystore|play-service-account>` stores a credential you have, from its files, as that JSON value through the adapter's `set`, or in `localSecrets()`'s directory. `hot-updater secrets issue <asc-api-key|play-service-account> [name]`, or its shortcuts `hot-updater apple login` and `hot-updater google-play login`, instead signs in with your Apple Account or Google and stores the key Hot Updater issues the same way. A sign-in never starts in CI or without a terminal, and a key that surely was not stored is revoked again.
  - Keys stay per machine: on a machine without one, the CLI says before signing in that it will issue a new key, and how to share one key instead (a store every machine reads, or `secrets put`); after issuing, it names where to revoke the keys no machine uses anymore. With `localSecrets()`, and with a GitHub remote and your GitHub token, it offers once to store the issued key as a GitHub Actions secret too, which a workflow maps into the job's environment, where `localSecrets()` reads it first: CI needs no adapter.

- 32de3ce: Upload an iOS build to TestFlight with `hot-updater native-build ios --submit testflight`, or its shortcut `hot-updater testflight`.
  - `testflight` runs `native-build ios`'s build, which tracks it, and takes only `--scheme`: any other option or argument exits 1 naming the full command. Without `--scheme`, it builds the one `nativeBuild.ios` scheme TestFlight takes and says which; with several, it asks at a terminal, and in CI or without a terminal it exits listing them with the full command. With none, it says why each scheme is refused and how to add one.
  - The upload authenticates with an App Store Connect API key, the scheme's `signing.ascApiKey` or else the `secrets` adapter's `asc-api-key`, which the `HOT_UPDATER_ASC_KEY*` environment variables override. The key is resolved before the build adapter's prebuild and the build, and its temporary file is deleted when the upload ends.
  - It uses the App Store Connect API's build uploads: it finds the app by the `.ipa`'s bundle ID, reserves its version and build number, uploads the file in the parts App Store Connect asks for, with only the headers each part lists, commits it, and waits up to 30 minutes for App Store Connect to accept the build, printing the warnings and errors it reports. A build number App Store Connect already has is reported as one to raise.
  - Before the prebuild, the CLI refuses, saying why, a scheme App Store Connect would not take: a simulator build, a Debug configuration, code signing turned off (`CODE_SIGNING_ALLOWED` or `CODE_SIGNING_REQUIRED` left `NO` after the overrides the build applies: `extraParams` settings, then the scheme's `xcconfig` and each `-xcconfig` in `extraParams`, resolved from `ios/` with their `#include`s, the last unconditional assignment winning; a setting a condition such as `[sdk=iphoneos*]` also sets is left to the build), a scheme that only archives, or an `exportOptionsPlist` of another method than App Store Connect; one the prebuild writes is checked before the build. `testflight` skips such schemes when it picks one.
  - Once App Store Connect accepts the build, the CLI records the submission on the tracked build, `submitted_to: "testflight"` with the version and build number as `submitted_version` (`1.7.0 (66)`), and the Console's Native builds tab shows it. Only an upload the run made is recorded; a build still processing, a failed upload, and `--dry-run` record nothing. `uploadToTestFlight`'s result has `shortVersion` and `bundleVersion`.
  - A reused build already submitted to TestFlight is not uploaded again, since App Store Connect takes each build number once: the CLI prints `Already on TestFlight since <time> as 1.7.0 (66). Bump the build number to upload a new build.` and exits 0, so a rerun CI job succeeds, and `--json` reports `submission.skipped: "already-submitted"` with the existing submission. A reused build the store has without a record, found by its version and build number, and App Store Connect's own refusal of a build number it already has, from another upload or tool, are skipped with the same line and record nothing, since the store's build may be another artifact; `@hot-updater/apple-helper` throws it as `TestFlightBuildExistsError`.
  - `@hot-updater/apple-helper` exports `uploadToTestFlight`, `resolveTestFlightUploadKey`, and `assertTestFlightExportOptions`.
  - Tracking also takes the built-in bundle out of an `.ipa` whose app name contains `[`, `*`, or `?`, which `unzip` read as wildcards.

### Patch Changes

- 98daf8d: `hot-updater native-build ios` with `installPods: true` builds an app whose `ios/` was just generated, such as an Expo app after the adapter's `expo prebuild`. From React Native 0.79, the `RCT_IGNORE_PODS_DEPRECATION=1` that `pod install` ran with also skipped its codegen, so without an earlier `ios/build/generated` it failed with `No podspec found for ReactAppDependencyProvider`. Codegen now runs before `pod install`, as the React Native CLI does, unless `RCT_SKIP_CODEGEN=1` or your own `RCT_IGNORE_PODS_DEPRECATION` leaves it to you or CocoaPods. The build also picks the `.xcworkspace` that `pod install` writes, where it used to build the bare `.xcodeproj` when no workspace existed yet.
- f5cffc0: `hot-updater native-build ios|android`, and `buildAndroid` and `buildIos` without a `minBundleId`, issue the MIN_BUNDLE_ID the SDK's podspec script phase and Gradle task generate: the UUIDv7 of the build's millisecond with all-zero random bits (`<ts>-<ts>-7000-8000-000000000000`), instead of a platform byte and random bits. `createMinBundleId(nowMs?)` from `@hot-updater/cli-tools` takes no platform. Before a tracked build, the CLI reads the registry once and steps the ID 1 ms forward while a bundle holds it. Two builds that start in the same millisecond, such as an iOS and an Android job of one CI run, still get the same ID: the registry refuses the second registration, and `native-build` now says another build registered that built-in bundle first and to build again, instead of `native_builds: exists`. The build cache doesn't reuse this machine's cached build when another build registered its MIN_BUNDLE_ID, so building again issues a new one. `native-build import` and every reader keep accepting any UUIDv7, so artifacts an earlier CLI built, whose MIN_BUNDLE_ID has a platform byte, still import.
- 288f6a9: An iOS scheme with `installPods: true` installs its pods before `native-build ios` computes the native build key, and the build uses them as installed. The key then holds the `Podfile.lock` the pods resolved to, and `Pods/Manifest.lock`, so a project whose `ios/` the build adapter's prebuild generates, such as an Expo app, can reuse a build instead of always building; pods that resolve differently still rebuild. A generated (git-ignored) `project.pbxproj` counts by its structure, with its objects labelled in the order they are reached from the root object, since `pod install` integrates a freshly generated project with new random object IDs each time; its files, groups, targets, build phases, settings, and their order still count. `@hot-updater/apple-helper` exports `installPodsIfNeeded`.
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

- Updated dependencies [007e0c5]
  - @hot-updater/cli-tools@1.1.2
  - @hot-updater/plugin-core@1.1.2

## 1.1.1

### Patch Changes

- @hot-updater/cli-tools@1.1.1
  - @hot-updater/plugin-core@1.1.1

## 1.1.0

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

- 3135b1c: `@hot-updater/react-native` ships a `Package.swift`, so React Native 0.87's experimental Swift Package Manager mode (`npx react-native spm`) autolinks it without `npx react-native spm scaffold`, which can't translate its mixed Swift and Objective-C++ sources. CocoaPods builds keep using `HotUpdater.podspec` and are unchanged.
  - A build tool plugin runs the same script as the podspec's script phase before every build, so SwiftPM builds also ship their own build time as `MIN_BUNDLE_ID`, and a `HOT_UPDATER_MIN_BUNDLE_ID` that is not a UUIDv7 fails the build. The plugin can read only the environment, not build settings, so `hot-updater build:ios` now passes its `HOT_UPDATER_MIN_BUNDLE_ID` both ways.
  - `react-native.config.js` sets `spm.name` to `HotUpdater`, which keeps `import HotUpdater` in `AppDelegate.swift` working.

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

- c9cfed7: Release the legacy Hermes fallback correction at 1.0.0-rc.25 with all public Hot Updater packages on the same RC.
- Updated dependencies [c9cfed7]
  - @hot-updater/cli-tools@1.0.0-rc.25
  - @hot-updater/plugin-core@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

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

- 03fd179: Run the `hot-updater` CLI from native ESM on Node 20 so TypeScript config
  files load through ESM import conditions.

  Require Node.js 20.19.0 or newer for the CLI package surface.

  Run the `hot-updater` CLI bin from the native ESM entrypoint and stop emitting
  a CommonJS build for the CLI entry.

  Bump the `hot-updater` CLI package's vulnerable `kysely` and
  `fast-xml-parser` dependency entries to patched versions without pnpm
  overrides.

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

- 169b019: chore: bump fast-xml-parser
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

- 90f9610: Improve native build logging stream handling and make iOS child process
  termination on Ctrl+C more reliable.
- Updated dependencies [90f9610]
- Updated dependencies [03c5adc]
  - @hot-updater/cli-tools@0.25.10
  - @hot-updater/plugin-core@0.25.10

## 0.25.9

### Patch Changes

- 6b22072: Change the default value of `podInstalls` option in iOS native build scheme to `false`
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
