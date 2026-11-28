---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/protocol": minor
"@hot-updater/server": minor
"@hot-updater/console": minor
"@hot-updater/standalone": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/postgres": minor
"@hot-updater/test-utils": minor
---

Record which native builds are sandbox builds and tag them **Sandbox** like the Store build tag, and make the native build booleans `is_*` and never null.

- `native_builds.store_build` (true or null) is now `is_store_build`, and the new sandbox fact is `is_sandbox`. Both are required booleans, true or false, in v1.2's existing `0002` migrations; `schema.core` stays `1.2.0`. One store build per scope is now kept by `store_build_scope_key`, a column the engine derives from `is_store_build` (the scope key on the store build, null on every other), under the unique index `byStoreBuild`. Boolean columns follow one rule: `is_*` for a fact about the row or `should_*` for an instruction to the client, never null.
- Derived string fields take `maxLength` and `ascii` like declared ones, so a derived key renders the right column on MySQL.
- `native-build android|ios` records `is_sandbox` from the scheme's `sandbox: true`, and `native-build import` from the artifact's sandbox layer. The admin API takes `isSandbox: boolean` on a registration, and refuses null.
- The registry refuses a registration whose `isSandbox` disagrees with its channel. A sandbox build registers only on a `sandbox-*` channel, and only a sandbox build registers there. A 1.2 prerelease CLI that registers a sandbox build without the field is refused with a 400 naming the reserved channel; upgrade the CLI with the server. Normal builds register as before.
- Everything that asks "is this a sandbox build" reads `is_sandbox`, not the channel. The Console tags the build **Sandbox** beside its kind in the Native builds list, its card, and the build's page, and hides **Mark as store build** for it. `native-build mark` refuses it by the record, and `find`, `download`, `delete` and `import` print `Kind  apk · sandbox`. `find --json`'s `nativeBuild` carries `is_sandbox` and `is_store_build`. The preview action tells a sandbox scheme from `find`'s `sandbox` result.
- `native-build mark --json` now reports the refusal `reason` as `sandbox_build`, not `sandbox_channel`.

If you deployed a 1.2.0 prerelease, its database already ran `0002` with `store_build`, and nothing reports it: the schema check, `hot-updater doctor` and `db migrate` all pass. Upgrade it in a maintenance window: stop everything that registers or marks native builds (CI jobs that run `native-build`, `deploy`, and the Console), run your database's SQL below, then deploy this release's server and CLI before you start them again. Until then, native build commands, `deploy`, and the Console's native build page fail; OTA update checks keep working. The SQL marks each scope's store build again and records the sandbox builds already registered (from their `sandbox-*` channel, once). It uses the default table names; with a `tablePrefix`, prepend it.

- Cloudflare D1, and Kysely on SQLite or libSQL. SQLite keeps the `DEFAULT 0`; nothing reads it, and the engine writes both columns:

  ```sql
  DROP INDEX IF EXISTS "native_builds_byStoreBuild";
  ALTER TABLE "native_builds" ADD COLUMN "is_store_build" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "native_builds" ADD COLUMN "is_sandbox" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "native_builds" ADD COLUMN "store_build_scope_key" TEXT;
  UPDATE "native_builds" SET "is_store_build" = 1, "store_build_scope_key" = "scope_key" WHERE "store_build" = 1;
  UPDATE "native_builds" SET "is_sandbox" = 1
    WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE substr("name", 1, 8) = 'sandbox-');
  ALTER TABLE "native_builds" DROP COLUMN "store_build";
  CREATE UNIQUE INDEX IF NOT EXISTS "native_builds_byStoreBuild" ON "native_builds" ("store_build_scope_key");
  ```

- Supabase:

  ```sql
  DROP INDEX IF EXISTS "hot_updater_v1_native_builds_byStoreBuild";
  ALTER TABLE "hot_updater_v1_native_builds"
    ADD COLUMN "is_store_build" boolean NOT NULL DEFAULT false,
    ADD COLUMN "is_sandbox" boolean NOT NULL DEFAULT false,
    ADD COLUMN "store_build_scope_key" varchar(2048) COLLATE "C";
  UPDATE "hot_updater_v1_native_builds" SET "is_store_build" = true, "store_build_scope_key" = "scope_key" WHERE "store_build" = true;
  UPDATE "hot_updater_v1_native_builds" SET "is_sandbox" = true
    WHERE "channel_id" IN (SELECT "id" FROM "hot_updater_v1_channels" WHERE substr("name", 1, 8) = 'sandbox-');
  ALTER TABLE "hot_updater_v1_native_builds"
    DROP COLUMN "store_build",
    ALTER COLUMN "is_store_build" DROP DEFAULT,
    ALTER COLUMN "is_sandbox" DROP DEFAULT;
  CREATE UNIQUE INDEX IF NOT EXISTS "hot_updater_v1_native_builds_byStoreBuild" ON "hot_updater_v1_native_builds" ("store_build_scope_key");
  ```

- PostgreSQL (`@hot-updater/postgres`, its Neon and Vercel re-exports, and Kysely on PostgreSQL):

  ```sql
  DROP INDEX IF EXISTS "native_builds_byStoreBuild";
  ALTER TABLE "native_builds"
    ADD COLUMN "is_store_build" boolean NOT NULL DEFAULT false,
    ADD COLUMN "is_sandbox" boolean NOT NULL DEFAULT false,
    ADD COLUMN "store_build_scope_key" varchar(2048) COLLATE "C";
  UPDATE "native_builds" SET "is_store_build" = true, "store_build_scope_key" = "scope_key" WHERE "store_build" = true;
  UPDATE "native_builds" SET "is_sandbox" = true
    WHERE "channel_id" IN (SELECT "id" FROM "channels" WHERE substr("name", 1, 8) = 'sandbox-');
  ALTER TABLE "native_builds"
    DROP COLUMN "store_build",
    ALTER COLUMN "is_store_build" DROP DEFAULT,
    ALTER COLUMN "is_sandbox" DROP DEFAULT;
  CREATE UNIQUE INDEX IF NOT EXISTS "native_builds_byStoreBuild" ON "native_builds" ("store_build_scope_key");
  ```

- Kysely on MySQL:

  ```sql
  DROP INDEX `native_builds_byStoreBuild` ON `native_builds`;
  ALTER TABLE `native_builds`
    ADD COLUMN `is_store_build` boolean NOT NULL DEFAULT false,
    ADD COLUMN `is_sandbox` boolean NOT NULL DEFAULT false,
    ADD COLUMN `store_build_scope_key` varchar(2048) CHARACTER SET ascii COLLATE ascii_bin;
  UPDATE `native_builds` SET `is_store_build` = 1, `store_build_scope_key` = `scope_key` WHERE `store_build` = 1;
  UPDATE `native_builds` SET `is_sandbox` = 1
    WHERE `channel_id` IN (SELECT `id` FROM `channels` WHERE BINARY SUBSTRING(`name`, 1, 8) = 'sandbox-');
  ALTER TABLE `native_builds`
    DROP COLUMN `store_build`,
    ALTER COLUMN `is_store_build` DROP DEFAULT,
    ALTER COLUMN `is_sandbox` DROP DEFAULT;
  CREATE UNIQUE INDEX `native_builds_byStoreBuild` ON `native_builds` (`store_build_scope_key`);
  ```

- Prisma and Drizzle: run `hot-updater db generate` so the ORM schema matches, then apply your dialect's SQL above by hand rather than the ORM's generated migration, which would drop `store_build` before copying it and can't add a NOT NULL column to a table with rows. Record the migration as applied (`prisma migrate resolve --applied <name>`, or Drizzle's journal) so the next diff is empty.

- MongoDB: drop the old index, then run `hot-updater db migrate <server file>`, whose schema step creates the new `byStoreBuild`. Prefix the collection name with your `tablePrefix`, if any:

  ```js
  for (const name of ["byStoreBuild", "native_builds_byStoreBuild"]) {
    if (db.native_builds.getIndexes().some((index) => index.name === name)) {
      db.native_builds.dropIndex(name);
    }
  }
  ```

MongoDB, DynamoDB, Firestore and Cosmos DB get no data backfill. A build registered before this release reads `is_store_build` and `is_sandbox` as false until it is written again. If you marked a store build on a prerelease, mark it again after upgrading with `hot-updater native-build mark <id>`; until then deploys patch from the scope's newest build. A sandbox build registered there before this release shows no **Sandbox** tag and can be marked as the store build: build the sandbox scheme again, or remove the old build with `hot-updater native-build delete <id>`.
