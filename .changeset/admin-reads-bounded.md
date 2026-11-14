---
"hot-updater": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/console": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
---

perf(server): four admin reads no longer grow with the size of a table. None of them is on a device's update path.

- **`native-build import`** finds an artifact that is already registered with one read of the unique `min_bundle_id` index. It no longer pages through the whole native build registry. Core adds `findNativeBuildByBuiltInBundle(bundleId)`, and the admin API adds the route `GET /native-builds/built-in/:bundleId`. A self-hosted server without this route answers 404, and the CLI asks you to upgrade it.
- **`findNativeBuild(scope, { builtInOlderThan })`**, the lookup a deploy uses to pick its patch base, keeps its result: the newest build of the scope whose built-in bundle is older than the bundle. When newer builds are in the way, it now reads at most 5 pages of 20 builds before the newest. It answers null when none of those 100 builds qualifies, where it used to read the whole scope. A deploy then makes no automatic patch, as it does for a scope with no older build.
- **The iOS device registry's account**, read before any claim, comes from one read of a new `ios_devices_byRegistration (registered_at_ms, id)` index. The registry is no longer scanned 200 rows at a time.
- **The Console's device list for an `.ipa`** looks up each UDID the IPA lists through its unique index. It no longer reads the whole registry.

If a 1.2.0 prerelease migrated your database before this release:

- **SQL and MongoDB** answer correctly without the index, which only makes the read fast. Create it once; this is safe to run again.
- **DynamoDB, Firestore, and Cosmos DB** keep no copy of the new index for a row written before it. Such a row is missed only by the account read of a registry with no account claimed yet. Builds always claim the account before they register a device, so that combination doesn't occur.

The statements:

- Cloudflare D1, SQLite, PostgreSQL, Neon: `CREATE INDEX IF NOT EXISTS "ios_devices_byRegistration" ON "ios_devices" ("registered_at_ms", "id");`
- Supabase: `CREATE INDEX IF NOT EXISTS "hot_updater_v1_ios_devices_byRegistration" ON "hot_updater_v1_ios_devices" ("registered_at_ms", "id");`
- MySQL: run ``SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'ios_devices' AND index_name = 'ios_devices_byRegistration';``. Only when it returns 0, run ``CREATE INDEX `ios_devices_byRegistration` ON `ios_devices` (`registered_at_ms`, `id`);``.
- MongoDB, DynamoDB, Firestore, Cosmos DB: nothing to run.
