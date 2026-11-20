---
"@hot-updater/protocol": patch
"@hot-updater/plugin-core": patch
"@hot-updater/server": patch
"@hot-updater/cli-tools": patch
"@hot-updater/test-utils": patch
"@hot-updater/standalone": patch
"@hot-updater/postgres": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/aws": patch
"@hot-updater/azure": patch
"@hot-updater/firebase": patch
"@hot-updater/vercel": patch
"hot-updater": patch
---

feat(release): each bundle gets a label, `v1`, `v2`, …, numbered per channel and platform.

- A deploy prints the bundle's label beside its ID, and `bundle list` shows it first. `--json` rows gain `label`, a number, or `null` until the database labels the bundle.
- A label never changes, and no other bundle of that channel and platform takes it while the channel exists: deleting a bundle leaves a gap, disabling or enabling one keeps its label, and a rollback takes none. A promotion takes the target channel's next label, and prints `Label  production v5 (from staging v12)`.
- `bundle show`, `update`, `enable`, `disable`, `delete` and `promote` take a label in place of the ID, with its channel and platform: `bundle show v12 -c production -p ios`.
- Release catalogs carry each bundle's label, so apps can read it.
- `hot-updater init` and `db migrate` label the bundles a database already holds, in the order they were deployed, and rebuild the catalogs that lack their labels. The first deploy to a channel and platform does it too. `hot-updater doctor` reports bundles without a label as `RELEASE_LABELS_MISSING`, and catalogs without them as `RELEASE_CATALOGS_WITHOUT_LABELS`, naming the command that migrates the database.
- `db migrate` adds the `label` column to an existing `releases` table on PostgreSQL, MySQL and SQLite, including a database a 1.2 release candidate migrated. Drizzle and Prisma add it through their own tooling after `db generate`, and `db migrate` names it while it is missing.
- A self-hosted server serves `GET /release-labels` and `POST /release-labels/fill` on its admin API. Against a server older than this release, the CLI says it can't look up labels: pass the bundle's ID.
- Database adapters may implement the optional `migrations.addColumns`, which the SQL kit implements; `lateColumnStatements` gives migration-file generators the `ALTER TABLE` statements for columns added to existing tables.
