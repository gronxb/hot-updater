---
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/cli-tools": patch
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/firebase": patch
"@hot-updater/vercel": patch
"@hot-updater/azure": patch
---

feat: turn on partitioned release catalogs through the server, with managed init and doctor support. Once every server runs 1.2.0, `npx hot-updater db partition-catalogs` lifts the 256 KB limit of an app-version scope's catalog. It can't be turned off.

- **The server turns it on, never the CLI.** `POST /release-catalog-partitioning` is the only product path that writes `catalog.partitioning = on`. The server first writes, reads back and deletes six probe rows in `release_catalog_partitions` with its own credentials, checking byte order and predecessors. On MongoDB it also needs a snapshot read. A refusal leaves the switch unset and the probe rows gone. The call is idempotent, and concurrent calls set the switch once. `createHotUpdater().core` has no enable, so no in-process caller or direct-database tool can turn it on.
- **Two doors.** On the admin mount, your framework authenticates the route. On the client mount, which managed servers expose, the route takes a ten-minute, single-use request token whose hash the caller stored in the settings table through the database (`core.issueReleaseCatalogPartitioningToken()`). Storing it takes the same credentials that could write the setting, so the route adds no secret. Missing, expired, used and wrong tokens all get the same 403. A server before 1.2.0 answers 404 on either door.
- **CLI.** `db partition-catalogs` calls the admin route over `standaloneRepository`. Over the server's own database it calls the client route at `--server-url`. It refuses with one line.
- **Managed init.** AWS turns partitioning on once CloudFront reports the distribution `Deployed` (the update path now waits too) and five cache-busted `/version` requests all answer this release. Cloudflare, Supabase, Firebase, Vercel and Azure report no such point, so init leaves partitioning off and prints the command with the server's URL. A replay on a partitioned database says so. The CloudFront distribution routes `/release-catalog-partitioning` to the function, and never caches a 500, 502, 503 or 504 (`ErrorCachingMinTTL: 0`). Agent scaffolds get `common.partition`.
- **Doctor** reports `details.releaseCatalogs.partitioning`: the switch, whether the server reads the table, and the app-version scopes still single-row after enable, as information. It warns `RELEASE_CATALOG_PARTITIONING_OFF` on a 1.2 database that could partition, `RELEASE_CATALOG_PARTITIONING_SWITCH_MISSING` when partitioned scopes outlive a deleted switch, and `RELEASE_CATALOG_PARTITIONS_MISSING` for a table the server can't read. A scope's layout comes from its own catalog row, never from rows in the partitions table. `HotUpdaterCoreApi.getReleaseCatalogPartitioning()` and `GET /release-catalog-partitioning` serve it, and a rebuild preflight reports the scope's `layout`.
