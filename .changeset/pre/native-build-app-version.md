---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/protocol": patch
"hot-updater": patch
"@hot-updater/console": patch
---

Every native build now shows the app version its artifact reports, whatever the update strategy.

**What is recorded.** `native_builds` records `native_app_version`, the artifact's own `CFBundleShortVersionString` or `versionName`. It is read when the build registers and never changes.

- A build reads it from the app it built: the archived `.app` of an `.ipa`, the simulator `.app`, or the manifest of an `.apk` or `.aab`.
- An import reads it from the imported artifact.
- It is null when the artifact's can't be read, and on a build registered before it was recorded.
- `app_version` is unchanged: it is still the version OTAs target, and it stays null on a fingerprint build.

**Where it shows.**

- **Console:** a fingerprint build's Target shows its version over the fingerprint, in the Native builds table, on its card, and on its page. A build without a version shows its fingerprint alone. An app-version build shows its version once, as before.
- **`native-build find`:** names a fingerprint build's app version, and `--json` carries it on `nativeBuild`.
- **Build summary:** a fingerprint build's heading names its version, such as `Android release 1.6.0 (66)`.

The admin API takes `nativeAppVersion` on `POST /native-builds` and returns `native_app_version` on every native build.

If a 1.2.0 prerelease migrated your database before this release, the column is missing; add it once. A database created from this release's migration already has it, so check first and skip the ALTER when `native_app_version` is listed.

- Cloudflare D1, SQLite: run `PRAGMA table_info("native_builds");`. Only when no row is named `native_app_version`, run `ALTER TABLE "native_builds" ADD COLUMN "native_app_version" TEXT;`. SQLite has no `IF NOT EXISTS` for a column, and running the ALTER again fails with `duplicate column name`.
- Supabase: `ALTER TABLE "hot_updater_v1_native_builds" ADD COLUMN IF NOT EXISTS "native_app_version" text COLLATE "C";` This is safe to run again.
- PostgreSQL, Neon: `ALTER TABLE "native_builds" ADD COLUMN IF NOT EXISTS "native_app_version" text COLLATE "C";` This is safe to run again.
- MySQL: run ``SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'native_builds' AND column_name = 'native_app_version';``. Only when it returns 0, run ``ALTER TABLE `native_builds` ADD COLUMN `native_app_version` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;``. MySQL has no `IF NOT EXISTS` for a column.
- MongoDB, DynamoDB, Firestore, Cosmos DB: nothing to do; a row without the field reads as null.
