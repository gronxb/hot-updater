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

Every native build `hot-updater native-build ios|android` makes is tracked in Hot Updater's native build registry, with no flag to opt out.

- Core's schema moves to 1.2.0 with the `native_builds` table, in the managed D1 and Supabase `0002_hot-updater_1.2.0.sql` migrations; `hot-updater doctor --fix` applies it. The table changes no existing one: its references to `channels` and `bundles` keep no counters.
- Before it builds, and before any Apple or Google sign-in, the CLI checks read-only that it can track the build: it asks the registry for the build's scope (for its newest build when the build adapter's prebuild has yet to generate the native project), and reads back (`exists`) the artifact of a build the registry already tracks there; when the database or the storage can't be reached, it stops in seconds naming which, and builds nothing. A Debug build, which loads its JavaScript from Metro and has no built-in bundle, is not tracked: the CLI says so before it builds, and `--json` reports `registration: { skipped: "debug" }`. When tracking fails after the build, the CLI exits with the artifact's path and submits it to no store.
- `--dry-run` builds but records and submits nothing, as `npm publish --dry-run` does: it runs the checks read-only, reads the store key `--submit` would use without signing in or issuing one, keeps the artifact on this machine, and prints what it would have recorded and where it would have submitted. A missing store key is reported, the build still runs, and the command exits 1 at the end. With `--json`, the last line has `dryRun: true`, `registration: { skipped: "dry-run" }`, and `submission: { skipped: "dry-run", destination }`.
- Tracking takes the JavaScript bundle a release build compiled in out of the artifact (`assets/index.android.bundle` in an `.apk`, `base/assets/index.android.bundle` in an `.aab`, `main.jsbundle` in an `.ipa` or `.app`), uploads the artifact to `native-builds/<platform>/<id>/` in the config's storage (a simulator `.app` as one `.app.zip`), uploads that bundle as the build's built-in bundle, a bundle whose ID is the MIN_BUNDLE_ID and whose manifest lists only that file at an OTA bundle's asset path, then registers both. It uses the config's `database` and `storage`, as deploy does.
- Core's API adds `registerNativeBuild`, which writes the build and its built-in bundle's row in one transaction, `findNativeBuild`, the newest build of a platform, channel, and fingerprint or exact app version in one indexed read, and `listNativeBuilds`. The admin API serves them at `POST /native-builds`, `GET /native-builds/latest`, and `GET /native-builds`, and `standaloneRepository` maps them; a server without these routes answers 404, which the CLI reports as a server to upgrade.
- A built-in bundle is no OTA bundle: no release publishes it, the bundle totals leave it out, core refuses to delete it or to release it, `hot-updater doctor --fix` keeps it, and `storage prune` keeps its files and the artifact. Update checks and artifact responses do not change.
- `azureBlobStorage` and `firebaseStorage` stream uploads instead of reading them into memory.
- `@hot-updater/android-helper` and `@hot-updater/apple-helper` export `extractBuiltInBundle`, and `@hot-updater/apple-helper` exports `archiveAppBundle`.
