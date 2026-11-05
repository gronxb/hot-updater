---
"hot-updater": minor
"@hot-updater/plugin-core": minor
"@hot-updater/protocol": minor
"@hot-updater/server": minor
"@hot-updater/console": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/postgres": minor
"@hot-updater/test-utils": minor
---

Record which native builds are sandbox builds, and tag them **Sandbox** like the Store build tag.

- `native_builds` has a nullable `sandbox`, true on a sandbox build and null on any other, never false, in v1.2's existing `0002` migrations. `schema.core` stays `1.2.0`. Registration sets it and nothing changes it afterwards.
- `native-build android|ios` sets it from the scheme's `sandbox: true`, and `native-build import` sets it from the artifact's sandbox layer. The admin API takes `sandbox: true | null` on a registration.
- The registry refuses a registration whose `sandbox` disagrees with its channel. A sandbox build registers only on a `sandbox-*` channel, and only a sandbox build registers there. A 1.2 prerelease CLI that registers a sandbox build without the field is refused with a 400 naming the reserved channel; upgrade the CLI with the server. Normal builds register as before.
- Everything that asks "is this a sandbox build" reads the field, not the channel. The Console tags the build **Sandbox** beside its kind in the Native builds list, its card, and the build's page, and hides **Mark as store build** for it. `native-build mark` refuses it by the record, and `find`, `download`, `delete` and `import` print `Kind  apk · sandbox`. `find --json`'s `nativeBuild` carries `sandbox`. The preview action tells a sandbox scheme from `find`'s `sandbox` result.
- `native-build mark --json` now reports the refusal `reason` as `sandbox_build`, not `sandbox_channel`.

If you deployed a 1.2.0 prerelease, its database already ran `0002` without `sandbox`, and nothing reports it: the schema check, `hot-updater doctor` and `db migrate` all pass. Add the column first, then backfill the sandbox builds already registered, then deploy this release's server and CLI, then run the same backfill once more to catch a build registered in between. Without the column, native build registration fails. The backfill only sets rows that are still null, so running it again is safe. The SQL below uses the default table names; with a `tablePrefix`, prepend it.

- Cloudflare D1, and Kysely on SQLite or libSQL:

  ```sql
  ALTER TABLE "native_builds" ADD COLUMN "sandbox" INTEGER;
  UPDATE "native_builds" SET "sandbox" = 1
    WHERE "sandbox" IS NULL
      AND "channel_id" IN (SELECT "id" FROM "channels" WHERE substr("name", 1, 8) = 'sandbox-');
  ```

- Supabase:

  ```sql
  ALTER TABLE "hot_updater_v1_native_builds" ADD COLUMN "sandbox" boolean;
  UPDATE "hot_updater_v1_native_builds" SET "sandbox" = true
    WHERE "sandbox" IS NULL
      AND "channel_id" IN (SELECT "id" FROM "hot_updater_v1_channels" WHERE substr("name", 1, 8) = 'sandbox-');
  ```

- PostgreSQL (`@hot-updater/postgres`, its Neon and Vercel re-exports, and Kysely on PostgreSQL):

  ```sql
  ALTER TABLE "native_builds" ADD COLUMN "sandbox" boolean;
  UPDATE "native_builds" SET "sandbox" = true
    WHERE "sandbox" IS NULL
      AND "channel_id" IN (SELECT "id" FROM "channels" WHERE substr("name", 1, 8) = 'sandbox-');
  ```

- Kysely on MySQL:

  ```sql
  ALTER TABLE `native_builds` ADD COLUMN `sandbox` boolean;
  UPDATE `native_builds` SET `sandbox` = 1
    WHERE `sandbox` IS NULL
      AND `channel_id` IN (SELECT `id` FROM `channels` WHERE BINARY SUBSTRING(`name`, 1, 8) = 'sandbox-');
  ```

- MongoDB, where the column needs nothing (prefix both collection names with your `tablePrefix`, if any):

  ```js
  const sandboxChannels = db.channels.distinct("_id", { name: /^sandbox-/ });
  db.native_builds.updateMany(
    { channel_id: { $in: sandboxChannels }, sandbox: { $in: [null] } },
    { $set: { sandbox: true } },
  );
  ```

- Prisma and Drizzle: run `hot-updater db generate`, apply it with the ORM, then run your dialect's `UPDATE` above.

DynamoDB, Firestore and Cosmos DB need no schema change, and get no backfill. A sandbox build registered there before this release shows no **Sandbox** tag and can be marked as the store build. Build the sandbox scheme again, or remove the old build with `hot-updater native-build delete <id>`. The new build registers with the tag.
