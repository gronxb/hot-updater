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
"@hot-updater/azure": minor
"@hot-updater/firebase": minor
"@hot-updater/test-utils": minor
---

Register native builds with `hot-updater build:android --register` and `build:ios --register`.

- Core's schema moves to 1.2.0 with the `native_builds` table, in the managed D1 and Supabase `0002_hot-updater_1.2.0.sql` migrations; `hot-updater doctor --fix` applies it. The table changes no existing one: its references to `channels` and `bundles` keep no counters.
- `--register` takes the JavaScript bundle a release build compiled in out of the artifact (`assets/index.android.bundle` in an `.apk`, `base/assets/index.android.bundle` in an `.aab`, `main.jsbundle` in an `.ipa` or `.app`), uploads the artifact to `native-builds/<platform>/<id>/` in the config's storage (a simulator `.app` as one `.app.zip`), uploads that bundle as the build's built-in bundle, a bundle whose ID is the MIN_BUNDLE_ID and whose manifest lists only that file at an OTA bundle's asset path, then registers both. It uses the config's `database` and `storage`, as deploy does, and refuses a debug build.
- Core's API adds `registerNativeBuild`, which writes the build and its built-in bundle's row in one transaction, `findNativeBuild`, the newest build of a platform, channel, and fingerprint or exact app version in one indexed read, and `listNativeBuilds`. The admin API serves them at `POST /native-builds`, `GET /native-builds/latest`, and `GET /native-builds`, and `standaloneRepository` maps them; a server without these routes answers 404, which the CLI reports as a server to upgrade.
- A built-in bundle is no OTA bundle: no release publishes it, the bundle totals leave it out, core refuses to delete it or to release it, `hot-updater doctor --fix` keeps it, and `storage prune` keeps its files and the artifact. Update checks and artifact responses do not change.
- `azureBlobStorage` and `firebaseStorage` stream uploads instead of reading them into memory.
- `@hot-updater/android-helper` and `@hot-updater/apple-helper` export `extractBuiltInBundle`, and `@hot-updater/apple-helper` exports `archiveAppBundle`.
