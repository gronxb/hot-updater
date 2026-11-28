---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/android-helper": minor
"@hot-updater/apple-helper": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/postgres": minor
---

`hot-updater native-build ios` and `native-build android` reuse a build instead of building again when nothing that can change the artifact changed. After the build adapter's prebuild, each build computes a native build key (`nbk1:` and a SHA-256) of every file of the git repository, the ignored native project files, `.env*` files, the install state and installed native packages it reads, what Expo and React Native CLI autolinking link (the config it prints, without this machine's directories, and each linked package file by file, wherever it is, with the ignored files of the repository's packages), the scheme's settings and files, the channel and fingerprint or app version, the signing identity (never a password or key), the toolchain, and the environment variables the build reads. A build the registry tracks with that key, whose artifact storage holds, is copied or downloaded to the output path, and nothing is built, tracked, or uploaded; else this machine's cached build with the key, such as a `--dry-run`'s, is tracked with its own min bundle ID; else the CLI builds and says what changed since the cached build. The CLI keeps one build per platform and scheme under `cacheDir`. A build no key can cover (Debug, outside git, autolinking that can't run, no `Podfile.lock` or `Package.resolved`, a dynamic Gradle version without a lockfile, environment reads by a computed name, device-list export methods, uninstalled provisioning profiles) always builds, and says why. `--no-cache` builds anyway and still records the key; `--submit` skips a reused build the store already has (`findTestFlightBuild` in `@hot-updater/apple-helper`, `findPlayInternalRelease` and `readBuiltVersionCode` in `@hot-updater/android-helper`); `--json` adds `cache: { hit, key, uncacheable, changed }`. The key is separate from the fingerprint, which keeps deciding which OTA updates a build takes, and `native-build find` keeps finding builds by scope.

Core's `native_builds` table has the nullable `build_key` column and the `byBuildKey` index, in the managed `0002_hot-updater_1.2.0.sql` migrations and the PostgreSQL schema. `NativeBuildRegistration` takes `buildKey`, `NativeBuildRow` has `build_key`, and `findNativeBuild(scope, { buildKey })` finds the newest build of a scope with a key in one read, also through `GET /native-builds/latest?buildKey=` and `standaloneRepository`, which reads a server's answer without the key as no build.
