---
"hot-updater": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
"@hot-updater/aws": patch
"@hot-updater/test-utils": patch
---

feat(server): core's schema adds the internal `release_catalog_partitions` table, with keys every database keeps in byte order. Nothing reads or writes it yet: it is where a later 1.2.0 change keeps a release catalog split into app-version partitions, once a database turns partitioning on. Until then, a database without it works exactly as before.

- **The table.** `scope_key`, `epoch`, `lower_key`, `generation`, `payload`, `partition_hash`, `byte_size`, keyed by `(scope_key, epoch, lower_key)`, with the `byScope` index in key order. No public API returns its rows.
- **Migrations.** 1.2.0's migration creates it on every database: `hot-updater db migrate`, `db generate` for Prisma and Drizzle, the managed `0002_hot-updater_1.2.0.sql` for Cloudflare D1 and Supabase (row-level security, and the apply RPC's table list), MongoDB's `db migrate`, and the agent infrastructure scaffolds, which ship the same files. The AWS role's DynamoDB policy lists `release_catalog_partitions` and `release_catalog_partitions#*`. Firestore and Cosmos DB need nothing.
- **Byte order.** Its keys compare by their bytes on every database: `COLLATE "C"` on PostgreSQL, `ascii_bin` on MySQL (`varbinary` from Prisma), SQLite's and D1's default binary collation, and the key-value kit's UTF-8 sort keys. MongoDB creates the collection and its index with simple collation, reads it with simple collation, and `db migrate` refuses a collection or index of another collation. `@hot-updater/test-utils` adds `setupKeyOrderTestSuite`, which checks scans, pages, predecessor reads, case-sensitive and long keys on the table as each route creates it.
- **Prisma.** `hot-updater db migrate` sets the collations Prisma can't declare on any table that lacks them, even when the schema settings already match, such as a table `prisma db push` created after an earlier migration. Before, it did that only while writing new settings. `createSettingsMigrator`'s `fixups` take an optional `pending`, the statements tables still need once the settings match.

If a 1.2.0 prerelease migrated your database before this release, its migration history already records 1.2.0, so the migration doesn't run again. Create the table once with the step below. Every step is safe to run again. Until the table exists, partitioning can't be turned on; nothing else reads or writes the table.

- **Cloudflare D1 (managed):** `npx wrangler d1 execute <database-name> --remote --file node_modules/@hot-updater/cloudflare/worker/migrations/0002_hot-updater_1.2.0.sql`
- **Supabase (managed):** `psql "<connection string>" -f node_modules/@hot-updater/supabase/supabase/migrations/0002_hot-updater_1.2.0.sql`, or paste the file into the SQL editor. It also adds the table to the `hot_updater_v1_apply` RPC.
- **PostgreSQL (Kysely, `@hot-updater/postgres`, Vercel, Neon):** `CREATE TABLE IF NOT EXISTS "release_catalog_partitions" ("scope_key" varchar(2048) COLLATE "C" NOT NULL, "epoch" varchar(36) COLLATE "C" NOT NULL, "lower_key" varchar(256) COLLATE "C" NOT NULL, "generation" bigint NOT NULL, "payload" text COLLATE "C" NOT NULL, "partition_hash" varchar(71) COLLATE "C" NOT NULL, "byte_size" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("scope_key", "epoch", "lower_key"));`
- **MySQL (Kysely):** ``CREATE TABLE IF NOT EXISTS `release_catalog_partitions` (`scope_key` varchar(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, `epoch` varchar(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, `lower_key` varchar(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, `generation` bigint NOT NULL, `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL, `partition_hash` varchar(71) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL, `byte_size` bigint NOT NULL, `_v` bigint NOT NULL DEFAULT 0, PRIMARY KEY (`scope_key`, `epoch`, `lower_key`));``
- **SQLite (Kysely):** `CREATE TABLE IF NOT EXISTS "release_catalog_partitions" ("scope_key" TEXT NOT NULL, "epoch" TEXT NOT NULL, "lower_key" TEXT NOT NULL, "generation" INTEGER NOT NULL, "payload" TEXT NOT NULL, "partition_hash" TEXT NOT NULL, "byte_size" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("scope_key", "epoch", "lower_key"));`
- **Prisma:** `npx hot-updater db generate`, apply it with `prisma db push` or `prisma migrate`, then `npx hot-updater db migrate`, which sets the new table's collations.
- **Drizzle:** `npx hot-updater db generate`, then apply it with `drizzle-kit push` or your drizzle-kit migrations.
- **MongoDB** (mongosh, with your collection prefix):

  ```js
  const name = "release_catalog_partitions";
  if (!db.getCollectionNames().includes(name)) db.createCollection(name, { collation: { locale: "simple" } });
  db.getCollection(name).createIndex({ scope_key: 1, epoch: 1, lower_key: 1 }, { name: "byScope", collation: { locale: "simple" } });
  ```

- **DynamoDB (managed AWS):** `npx hot-updater init --provider aws --from-env-file .env.hotupdater` puts the role's policy with the new table. A role you manage yourself adds `release_catalog_partitions` and `release_catalog_partitions#*` to its `dynamodb:LeadingKeys`.
- **Firestore, Cosmos DB:** nothing to run.

With a table prefix, prefix the table name in each statement.
