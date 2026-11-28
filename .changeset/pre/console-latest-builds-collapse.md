---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"hot-updater": minor
"@hot-updater/console": minor
"@hot-updater/standalone": minor
"@hot-updater/apple-helper": minor
---

Native builds and Bundles now lead with the rows that matter and fold the rest where they sit.

- **Native builds** lead with the newest build of each distribution path, and with the store build. A distribution path is a platform, a channel, sandbox or not, and how the build reaches people: the store track it was submitted to, or else its artifact. An `.ipa` is split by its export method.
- **Bundles** lead with the reachable bundles. The selected bundle shows as a row wherever it sits.
- **Folds.** Every run of other rows between two leading rows is one fold in its place, such as "5 older builds" or "2 unreachable bundles". Each fold opens on its own and shows exactly those rows, in order.
- **Filters.** The Disabled and artifact filters fold nothing.

**Paging.** A page holds 20 leading rows, plus the run under its last one, so the next page starts with a leading row.

- The Console server reads ahead through the list's own index, at most 200 rows a page, counting the rows it reads to classify them.
- A run that outlasts the budget ends the page in a fold that goes on, and the next page continues it.
- A fold's count is exact up to 100 and "100+" beyond. A fold's rows are read when it opens, exactly its range, 50 at a time.
- A page's cursor remembers where the 20 pages before it started, so Previous shows a page exactly as Next did. Past those, Previous reads up from the page's first row: its page breaks may differ, but no row is skipped or repeated.
- Rows are in build ID order, which is the order they were registered in.

**Keyset reads.** A keyset read, such as `listNativeBuilds`, takes `through`, a key it ends with, so one read covers one range. The admin API and the standalone adapter pass it as the `through` query parameter.

**Newer build.** A native build is older when the list has read a newer build (a greater ID) on its path: on its own page, or above the page through its channel's existing index. A newer build further up than that read reaches leaves the build leading.

**Export method.** `native_builds` records `export_method` (`app-store`, `ad-hoc`, `development`, `enterprise`, or null). When the CLI builds an `.ipa`, it takes the `method` of the export options it exported with and confirms it with the `.ipa`'s embedded profile: devices listed mean ad hoc or development, all devices mean enterprise, neither means the App Store. It records null when the two disagree or either is missing, as for an imported `.ipa`, and a build registered before this has null too. A null `.ipa` is on the plain `ipa` path.

If you migrated a database with a 1.2.0 prerelease, add the column by hand:

- Cloudflare D1, SQLite: `ALTER TABLE "native_builds" ADD COLUMN "export_method" TEXT;`
- Supabase: `ALTER TABLE "hot_updater_v1_native_builds" ADD COLUMN "export_method" varchar(16) COLLATE "C";`
- PostgreSQL: `ALTER TABLE "native_builds" ADD COLUMN "export_method" varchar(16) COLLATE "C";`
- MySQL: ``ALTER TABLE `native_builds` ADD COLUMN `export_method` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;``
- MongoDB, DynamoDB, Firestore, Cosmos DB: nothing to do; a row without the field reads as null.
