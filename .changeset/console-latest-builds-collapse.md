---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"hot-updater": minor
"@hot-updater/console": minor
---

Native builds and Bundles lead with the rows that matter and fold the rest where they sit. Native builds lead with the newest build of each distribution path, and with the store build. A distribution path is a platform, a channel, sandbox or not, and how the build reaches people: the store track it was submitted to, or else its artifact, with an `.ipa` split by its export method. Bundles lead with the reachable bundles and the selected one. Every run of other rows between two leading rows is one fold in its place, such as "5 older builds" or "2 unreachable bundles", and each fold opens on its own to show exactly those rows, in order. The Disabled and artifact filters fold nothing.

A page holds 20 leading rows, plus the run under its last one, so the next page starts with a leading row. The Console server reads ahead through the list's own index a chunk at a time, at most 200 rows a page. A run that outlasts that budget ends the page in a fold that goes on, and the next page continues it. A fold's count is exact up to 100 and "100+" beyond. A fold's rows are read when it opens.

`native_builds` records `export_method` (`app-store`, `ad-hoc`, `development`, `enterprise`, or null), which the CLI reads from the `.ipa`'s embedded profile when it registers a build or an import. The engine derives `distribution` from the row, and the `byDistributionPath` index orders each path by the registry's server time, so `findNativeBuildOnPath` reads a path's newest build in one indexed read. The admin API serves it at `GET /native-builds/on-path`, and `standaloneRepository` maps it. Both are in v1.2's existing `0002` migrations.

If you migrated a database with a 1.2.0 prerelease, add the column, the derived column, and the index by hand. Builds registered before this record no export method, so an `.ipa` among them is on the plain `ipa` path.

- Cloudflare D1, SQLite:

  ```sql
  ALTER TABLE "native_builds" ADD COLUMN "export_method" TEXT;
  ALTER TABLE "native_builds" ADD COLUMN "distribution" TEXT;
  UPDATE "native_builds" SET "distribution" = COALESCE("submitted_to", "artifact_kind");
  CREATE INDEX IF NOT EXISTS "native_builds_byDistributionPath" ON "native_builds" ("channel_id", "platform", "is_sandbox", "distribution", "created_at_ms", "id");
  ```

- Supabase:

  ```sql
  ALTER TABLE "hot_updater_v1_native_builds"
    ADD COLUMN "export_method" varchar(16) COLLATE "C",
    ADD COLUMN "distribution" varchar(32) COLLATE "C";
  UPDATE "hot_updater_v1_native_builds" SET "distribution" = COALESCE("submitted_to", "artifact_kind");
  CREATE INDEX IF NOT EXISTS "hot_updater_v1_native_builds_byDistributionPath" ON "hot_updater_v1_native_builds" ("channel_id", "platform", "is_sandbox", "distribution", "created_at_ms", "id");
  ```

- PostgreSQL:

  ```sql
  ALTER TABLE "native_builds"
    ADD COLUMN "export_method" varchar(16) COLLATE "C",
    ADD COLUMN "distribution" varchar(32) COLLATE "C";
  UPDATE "native_builds" SET "distribution" = COALESCE("submitted_to", "artifact_kind");
  CREATE INDEX IF NOT EXISTS "native_builds_byDistributionPath" ON "native_builds" ("channel_id", "platform", "is_sandbox", "distribution", "created_at_ms", "id");
  ```

- MySQL:

  ```sql
  ALTER TABLE `native_builds`
    ADD COLUMN `export_method` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin,
    ADD COLUMN `distribution` varchar(32) CHARACTER SET ascii COLLATE ascii_bin;
  UPDATE `native_builds` SET `distribution` = COALESCE(`submitted_to`, `artifact_kind`);
  CREATE INDEX `native_builds_byDistributionPath` ON `native_builds` (`channel_id`, `platform`, `is_sandbox`, `distribution`, `created_at_ms`, `id`);
  ```

- MongoDB: `db migrate` creates the index. Set the derived field on the builds that lack it:

  ```js
  db.native_builds.updateMany(
    { distribution: { $exists: false } },
    [{ $set: { distribution: { $ifNull: ["$submitted_to", "$artifact_kind"] } } }],
  );
  ```

- Key-value stores (DynamoDB, Firestore, Cosmos DB): an index is items the engine writes with each row, so a build registered before this has no `byDistributionPath` item until its row is next written. Until then, its path's newest is read from the builds that have one, and a path with none shows each of its builds as leading. New builds are indexed when they register.
