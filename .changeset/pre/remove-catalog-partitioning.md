---
"@hot-updater/server": patch
"@hot-updater/standalone": patch
"@hot-updater/aws": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
---

fix: 1.2.0 keeps one release catalog row per scope, with its 256 KiB limit, and drops the partitioned release catalogs that `next` carried after 1.2.0-rc.49. No published release had them. Gone: the `release_catalog_partitions` table in every migration, schema and scaffold; `db partition-catalogs`; `GET` and `POST /release-catalog-partitioning`; the app-version tiling kit and `DatabaseAdapter`'s `readSnapshot` and `maxQueriesPerRequest` in `@hot-updater/plugin-core`; and the partitioning parts of init, doctor and the docs.

- **The size limit.** A release change whose catalog would be over 256 KiB is still refused before anything is written. The refusal now names the channel and platform, and says to disable or delete old bundles on that channel. Over `standaloneRepository` the server answers it as 400 `CATALOG_OVERSIZE`, which the CLI throws as `ReleaseCatalogCompilationError`, as in process; before, it was a 500.
- **Doctor** warns `RELEASE_CATALOG_NEAR_LIMIT` when a scope's catalog reaches 80% of the limit, from the reads it already makes.
- **Strong reads.** The MongoDB adapter reads on the primary, whatever read preference its client has. The Prisma and Drizzle adapters run every statement on the primary under a read-replica extension (`$primary()`) or `withReplicas` (`$primary`). The adapter contract page lists how each built-in adapter reads strongly, and the conformance suite checks that a read sees the write committed just before it.
- **AWS.** The CloudFront distribution never caches a 500, 502, 503 or 504 (`ErrorCachingMinTTL: 0`, no replacement page), on a new distribution and on the existing one init updates.
