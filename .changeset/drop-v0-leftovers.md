---
"@hot-updater/server": minor
"@hot-updater/plugin-core": minor
"@hot-updater/standalone": patch
"@hot-updater/firebase": patch
"hot-updater": patch
"@hot-updater/expo": patch
---

Remove options and messages left over from v0.

- `drizzleAdapter` no longer takes `schema`, which it ignored. TypeScript now reports it: delete it.
- `MigrateOptions` no longer has `mode`: every migration already ran from the schema. Delete `mode: "from-schema"` from `migrateToLatest` calls.
- `@hot-updater/js` is no longer published. It only copied `semverSatisfies` and `filterCompatibleAppVersions` from `@hot-updater/plugin-core`.
- Messages say what is wrong without naming a version:
  - `createHotUpdater` refuses a `database` that is not a Hot Updater database adapter, such as `kyselyAdapter(...)` or `postgres(...)`.
  - The Kysely, Drizzle, and Prisma adapters list the supported providers.
  - `standaloneRepository` refuses a server whose `/version` does not report admin API protocol 2, and asks for the path where the server mounts `handlers.admin`.
  - Firebase `init` refuses an incompatible Function `hot-updater-v1` with its own message.
  - `hot-updater doctor` names `com.hotupdater.FINGERPRINT_HASH` in `AndroidManifest.xml` when it does not match `fingerprint.json`.
- The Expo config plugin no longer deletes `hot_updater_*` strings from `strings.xml`. They have no effect: prebuild writes the manifest meta-data the app reads.
