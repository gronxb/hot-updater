---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"hot-updater": minor
"@hot-updater/console": minor
---

Native builds and Bundles now lead with the rows that matter and fold the rest where they sit.

- **Native builds** lead with the newest build of each distribution path, and with the store build. A distribution path is a platform, a channel, sandbox or not, and how the build reaches people: the store track it was submitted to, or else its artifact. An `.ipa` is split by its export method.
- **Bundles** lead with the reachable bundles. The selected bundle shows as a row wherever it sits.
- **Folds.** Every run of other rows between two leading rows is one fold in its place, such as "5 older builds" or "2 unreachable bundles". Each fold opens on its own and shows exactly those rows, in order.
- **Filters.** The Disabled and artifact filters fold nothing.

**Paging.** A page holds 20 leading rows, plus the run under its last one, so the next page starts with a leading row.

- The Console server reads ahead through the list's own index, at most 200 rows a page, counting the rows it reads to classify them.
- A run that outlasts the budget ends the page in a fold that goes on, and the next page continues it.
- A fold's count is exact up to 100 and "100+" beyond. A fold's rows are read when it opens.
- A page's cursor remembers where the pages before it started, so Previous shows a page exactly as Next did.

**Newer build.** A native build is older when the list has read a newer build (a greater ID) on its path: on its own page, or above the page through its channel's existing index. A newer build further up than that read reaches leaves the build leading.

**Export method.** `native_builds` records `export_method` (`app-store`, `ad-hoc`, `development`, `enterprise`, or null). The CLI reads it from the `.ipa`'s embedded profile when it registers a build or an import. An `.ipa` with no readable profile records null, and so does a build registered before this. A null `.ipa` is on the plain `ipa` path.

If you migrated a database with a 1.2.0 prerelease, add the column by hand:

- Cloudflare D1, SQLite: `ALTER TABLE "native_builds" ADD COLUMN "export_method" TEXT;`
- Supabase: `ALTER TABLE "hot_updater_v1_native_builds" ADD COLUMN "export_method" varchar(16) COLLATE "C";`
- PostgreSQL: `ALTER TABLE "native_builds" ADD COLUMN "export_method" varchar(16) COLLATE "C";`
- MySQL: ``ALTER TABLE `native_builds` ADD COLUMN `export_method` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;``
- MongoDB, DynamoDB, Firestore, Cosmos DB: nothing to do; a row without the field reads as null.
