---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/console": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/postgres": minor
"@hot-updater/test-utils": minor
---

Mark the build the store sells, so a fresh install's first OTA stays a patch however many builds follow it.

- `hot-updater native-build mark <id> [--clear]` marks a build as its scope's store build, replacing the scope's mark in one write, or clears it. A build on a `sandbox-*` channel can't be marked. Run it again and it changes nothing. It changes no OTA already out: when the OTA a fresh install gets first has no patch from the build, it prints the `hot-updater patch` command that adds one, and `--json` carries it as `missingPatch`. The Native builds page in the Console has the same action, and shows the same command.
- `hot-updater deploy` patches from exactly one built-in bundle of its scope: the store build, or with no mark the most recently registered build, in one more indexed read. It prints which one, and whether it was marked. A build made after the deployed bundle is passed over for an older one instead of leaving the deploy with no built-in base.
- A target range such as `1.x.x`, and a default target such as `1.7.x` for a project at `1.7`, use the project's app version for that lookup when the range holds it. They found no build before.
- `native_builds` has a nullable `store_build` and a unique `byStoreBuild` index, in v1.2's existing `0002` migrations. `schema.core` stays `1.2.0`, so a database a v1.2 prerelease migrated needs the column and the index by hand.

If you deployed a 1.2.0 prerelease, its database already ran `0002` without `store_build`, and nothing reports it: the schema check, `hot-updater doctor` and `db migrate` all pass. Apply this before you deploy this release's server or CLI, or native build registration and `native-build mark` fail:

- Cloudflare D1, and Kysely on SQLite or libSQL:

  ```sql
  ALTER TABLE "native_builds" ADD COLUMN "store_build" INTEGER;
  CREATE UNIQUE INDEX IF NOT EXISTS "native_builds_byStoreBuild" ON "native_builds" ("scope_key", "store_build");
  ```

- Supabase:

  ```sql
  ALTER TABLE "hot_updater_v1_native_builds" ADD COLUMN "store_build" boolean;
  CREATE UNIQUE INDEX IF NOT EXISTS "hot_updater_v1_native_builds_byStoreBuild" ON "hot_updater_v1_native_builds" ("scope_key", "store_build");
  ```

- PostgreSQL (`@hot-updater/postgres`, and Kysely on PostgreSQL):

  ```sql
  ALTER TABLE "native_builds" ADD COLUMN "store_build" boolean;
  CREATE UNIQUE INDEX IF NOT EXISTS "native_builds_byStoreBuild" ON "native_builds" ("scope_key", "store_build");
  ```

- Kysely on MySQL:

  ```sql
  ALTER TABLE `native_builds` ADD COLUMN `store_build` boolean;
  CREATE UNIQUE INDEX `native_builds_byStoreBuild` ON `native_builds` (`scope_key`, `store_build`);
  ```

- MongoDB:

  ```js
  db.native_builds.createIndex(
    { scope_key: 1, store_build: 1 },
    { name: "native_builds_byStoreBuild", unique: true, partialFilterExpression: { store_build: { $exists: true } } },
  );
  ```

- Prisma and Drizzle: run `hot-updater db generate`, then apply it with the ORM.

DynamoDB, Firestore and Cosmos DB need nothing.

