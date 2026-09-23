# A0: v1 schema amendment for the database adapter redesign

Status: **proposed; the owner's sign-off gates A1.**
Baseline: `origin/next` at `c98d441b3` (packages at `1.0.0-rc.15`).
Source: the [Database Adapter & Plugin Redesign PRD](https://claude.ai/code/artifact/57079726-3938-47e8-93f7-b308f3720c8c)
(Core schema, Insights schema, Backend implementations, Key-value layout, Review decisions 1, 14, 27, 31, 32).

v1 is amended in place, every RC database is recreated, and one fence on every backend refuses
an unrecreated database before its first read. This record fixes the physical schema that the
engine (A1–A6), the plugins (B1–B4), core (C1–C3), and each provider (D1–D9) build against.

## Decisions

| # | Decision | Detail |
|---|---|---|
| 1 | Amend v1 in place; recreate RC databases | [Scope](#1-amend-v1-in-place) |
| 2 | Fence: `schema.engine = "1"` on every backend | [Fence](#2-fence) |
| 3 | Module keys `schema.core`, `schema.insights`, `schema.apiKeys` | [Module keys](#3-module-keys) |
| 4 | Engine columns `_v`, `_refs_<table>_<col>`, `_shard` | [Engine columns](#4-engine-columns) |
| 5 | Derived fields are real columns; multi-valued ones become native multi-entry indexes | [Derived fields](#5-derived-fields) |
| 6 | New and re-keyed aggregate tables | [Aggregates](#6-aggregates) |
| 7 | `tablePrefix` on every adapter; one DynamoDB table and one Firestore collection | [Naming](#7-naming) |
| 8 | Whole numbers are `bigint`; strings compare in binary order | [Value types](#8-value-types) |
| 9 | Amend `infrastructure-upgrades/1.0.0.md`; add no new version file | [Upgrade doc](#9-upgrade-doc) |
| 10 | Provider SQL is generated from the resolved schema, never hand-written | [Generated SQL](#10-generated-sql) |

### 1. Amend v1 in place

- `HOT_UPDATER_SCHEMA_VERSION` stays `1.0.0`. `schema/v1_0_0.ts` is replaced by module schemas
  declared with `defineTable`/`defineAggregate` and resolved by the engine (A2).
- The `1.0.0` artifacts are regenerated in place: SQL generator output, the Mongo migrator,
  D1 `worker/migrations/0001_hot-updater_1.0.0.sql` (D5), and Supabase
  `20260818000000_hot-updater_1.0.0.sql` (D6). Supabase's `20260922000000_idempotent_channel_commit.sql`
  folds into the regenerated migration because its RPC is replaced.
- Databases created by `1.0.0-rc.0` through `rc.15` are recreated; there is no conversion tool.
  Bundles are redeployed from their source artifacts, as the 1.0.0 guide already requires for v0.

### 2. Fence

- Settings key `schema.engine`, value `"1"`: the engine's storage-layout generation (engine
  columns, index tables and items, key encoding, settings layout). It changes only together with
  a migration.
- A separate key is needed because `schema.core` stayed `"1.0.0"` through about ten in-place
  schema edits (#1149 → #1319); its value cannot tell a pre-redesign RC database from a recreated
  one. A missing or different `schema.engine` fails the fence.
- The engine checks the fence on **every** backend before a process's first read: one batch `get`
  of `schema.engine` plus each installed module's key. Success is cached for the process; failure is
  rechecked on the next call. Today only Kysely and MongoDB check, Firestore checks its own
  `{version: 4}` document, and Drizzle, Prisma, Postgres, D1, Supabase, and DynamoDB never check.
- A mismatch throws `HotUpdaterSchemaMigrationRequiredError` naming the key, the expected value, and
  the found value; handlers keep answering 503. The CLI checks the fence through
  `@hot-updater/server/db` before its first read.
- Migrations write the settings rows last, after every table and index exists. `db migrate`
  refuses a database that has `schema.core` but no `schema.engine` and prints the recreate step.
- Every backend gets a migration step that writes the settings rows; the runtime never writes them.
  - Kysely and MongoDB: `db migrate` applies DDL or collections, then the rows (as today).
  - Drizzle and Prisma: drizzle-kit or Prisma applies the DDL; `db migrate` then writes only the
    rows (today nothing writes them). D2 and D3.
  - Postgres plugin, D1, Supabase: the generated migration ends with the rows (decision 10).
  - DynamoDB and Firestore: no DDL, so the migration writes only the settings items; IaC, agent
    scaffolds, and `e2e-service.sh` run it. Firestore's lazily created `{version: 4}` marker goes
    away. D8 and D9.

### 3. Module keys

| Key | Value | Written when |
|---|---|---|
| `schema.engine` | `"1"` | Every migration |
| `schema.core` | core's `schemaVersion`, `"1.0.0"` | Always; core cannot be removed |
| `schema.insights` | `"1.0.0"` | The insights plugin is installed |
| `schema.apiKeys` | `"1.0.0"` | The api-keys plugin is installed |
| `schema.<plugin id>` | the plugin's `schemaVersion` | A third-party plugin is installed |

Installing a plugin later means running migrations again; the fence names the missing key.
The legacy `"version"` fallback in `getVersion()` goes away in E2.

### 4. Engine columns

| Column | Type | On | Meaning |
|---|---|---|---|
| `_v` | `bigint`, not null, default 0 | Every base and aggregate table | Row version. Every patch and increment bumps it; patch, delete, and check guard on it; `tx.findMany` guards the root row's `_v` |
| `_refs_<table>_<col>` | `bigint`, not null, default 0 | The referenced table, one per `restrict` or `cascade` relation | Rows of `<table>` whose `<col>` points at this row. `restrict` deletes need 0; `cascade` uses it to bound the child delete by `fits()` |
| `_shard` | `integer`, not null | Aggregate tables | Shard number and the last primary-key column; `0` for unsharded aggregates |

Index rows and items never carry `_v` or counters. MongoDB's `check` op increments an
adapter-private `_c` field, written lazily and outside the resolved schema.

| Relation (core) | `onDelete` | Counter on the parent |
|---|---|---|
| `bundle_patches.bundle_id` → `bundles` | cascade | `bundles._refs_bundle_patches_bundle_id` |
| `bundle_patches.base_bundle_id` → `bundles` | cascade | `bundles._refs_bundle_patches_base_bundle_id` (the console's child count) |
| `releases.bundle_id` → `bundles` | restrict | `bundles._refs_releases_bundle_id` |
| `releases.channel_id` → `channels` | restrict | `channels._refs_releases_channel_id` |
| `releases.source_release_id` → `releases` | none | — |
| `release_catalogs.channel_id` → `channels` | none | — (empty catalogs are reused through `scope_key`) |

Database foreign keys stay in generated SQL until E2 (review decision 31), so code that has not
switched keeps today's `cascade`, `restrict`, and `set null` behavior. E2 drops them.

### 5. Derived fields

- A single-valued derived field is a real nullable column written by the engine. A null value
  never matches an index read, because every read binds non-null eq values.
- A multi-valued derived field (at most 16 values) is realized natively by each adapter family:
  - SQL (PostgreSQL, MySQL, SQLite, D1, Supabase): an index table `<table>__<index>` holding the
    index's eq columns, sort columns, and the base key, one row per value, primary key over all of
    them. The `sqlAdapter` core maintains it in the same transaction from the `row` and `previous`
    carried by write ops, and reads join it to the base table.
  - MongoDB: an array field with a multikey compound index.
  - DynamoDB and Firestore: one index item per value (KV layout in the PRD).
- v1 has one multi-valued field: `bundle_events.bundle_ref`.

### 6. Aggregates

- Counters are blind increments that bump `_v`. Gauges and HLL sketches are read, merged, and
  written back per shard; a gauge row at zero is deleted. Sketches live in their own tables.
- `_shard` comes from the aggregate's `shardBy` (install id for insights). Shard counts are fixed
  once data exists; changing one requires recreating that aggregate's rows.
- Aggregate rows are addressed by their full key, so they need no separate index items or tables.
- The tables are listed in [Resolved schema](#resolved-schema).

### 7. Naming

- Every adapter factory takes `tablePrefix` (default `""`); the physical name is
  `tablePrefix + logical name` for SQL tables, MongoDB collections, and KV partitions.
- Supabase defaults `tablePrefix` to `hot_updater_v1_`, so its tables keep today's names. The
  settings table follows the same rule and becomes `hot_updater_v1_private_hot_updater_settings`
  (today `hot_updater_v1_private_settings`).
- DynamoDB keeps one table (`tableName`, default `hot-updater-v1`) keyed by `pk`/`sk`, and D8 drops
  the `hot-updater-update-index` GSI.
- Firestore moves from ten `hot_updater_v1_*` collections to one collection (`collection`, default
  `hot_updater_v1`) of `{ pk, sk, row }` documents. Because the collection already namespaces the
  data, `tablePrefix` defaults to `""` there. This refines the PRD's "keeps today's names on
  Firestore": the namespace is kept, the per-table collections are not. `row` is exempt from
  single-field indexing (catalog payloads and sketches exceed Firestore's indexed-value limit).

### 8. Value types

Engine values are `string | number | boolean | null | Json`. Keys and index fields are strings,
safe integers, or booleans; JSON never appears in a key or an index.

| Engine type | PostgreSQL / Supabase | MySQL | SQLite / D1 | MongoDB | DynamoDB | Firestore |
|---|---|---|---|---|---|---|
| string | `text`/`varchar`, `COLLATE "C"` | `varchar`, `utf8mb4_bin` (`ascii_bin` for catalog keys) | `TEXT` (`BINARY`) | string | S | string |
| whole number | `bigint` (read as string, converted) | `bigint` | `INTEGER` | int/long/double, normalized | N | integer |
| boolean | `boolean` | `tinyint(1)` (read as 0/1) | `INTEGER` 0/1 | bool | BOOL | boolean |
| JSON | `jsonb` | `json` | `TEXT` | document/array | M/L | map/array |
| null | `NULL` | `NULL` | `NULL` | null | attribute absent | field absent |

- Whole-number fields become `bigint` holding safe integers: every `*_ms`, `generation`,
  `revision`, `byte_size`, `order_index`, `rollout_cohort_count`, and every counter and gauge.
  Today most are `float` (for example `bundle_patches.byte_size`, `received_at_ms`); the engine
  rejects values that are not safe integers.
- Strings compare in binary (UTF-8) order everywhere; the collations above are pinned. UUIDv7 ids
  sort the same as `uuid` values and as text.
- HLL sketches are 1,024-character strings (`large-string`).

### 9. Upgrade doc

Amend `packages/hot-updater/infrastructure-upgrades/1.0.0.md` and its `INFRASTRUCTURE_UPDATES`
note; add no new version file. 1.0.0 is unreleased, the file already records pre-GA amendments
(the `insights_overview` addition), and the validator requires exactly one file per registered
version. D1 makes the first amendment (Compatibility: "RC databases created before the adapter
redesign must be recreated"); D4, D5, D6, D8, and D9 update their provider sections.

### 10. Generated SQL

The Postgres plugin's `sql/bundles.sql`, D1's `0001` migration and test-only `sql/bundles.sql`, and
the Supabase migration are generated from the resolved schema by `@hot-updater/server/db` (DDL
from A6), with a test that fails when a checked-in file differs from the generator output. Today
they are hand-written and have drifted from the DSL (collations, `jsonb`, D1's extra
`insights_processed` column). Drizzle's generated settings table uses `key`/`value` like the
others (today `id`/`version`), and migrations write the settings rows for Drizzle and Prisma too
(today nothing writes them).

## Resolved schema

Brackets read `[eq fields; sort fields]`; every sort is completed by the primary key, which also
closes cursors. An index whose eq is empty and whose sort is the key is served by the base rows.

### Core (`schema.core`)

| Table | Key | Indexes | Change against `v1_0_0.ts` |
|---|---|---|---|
| `bundles` | `id` | `byPlatform [platform; id]`, `all [; id]` | + `_v`, three `_refs_*` counters; `byPlatform` on every backend (today MongoDB only) |
| `bundle_patches` | `id` | `pair [bundle_id, base_bundle_id]` unique; `byBundle [bundle_id; order_index]` rooted at `bundles`; `byBase [base_bundle_id; bundle_id]` | + `_v`; the unique `pair` is new; the two single-column indexes are replaced |
| `releases` | `id` | `byScope [scope_key; id]`, `byScopeEnabled [scope_key, enabled; id]` (both rooted at `release_catalogs`); `byChannelPlatform [channel_id, platform; id]`; `byChannelPlatformEnabled [channel_id, platform, enabled; id]`; `byBundle [bundle_id; id]`; `all [; id]` | + `_v`; two enabled indexes are new; `releases_fingerprint_hash_idx` and `releases_enabled_idx` are dropped |
| `release_catalogs` | `scope_key` | `all [; scope_key]` | + `_v`; `release_catalogs_channel_idx` is dropped |
| `channels` | `id` | `name` unique; `all [; name]` | + `_v`, `_refs_releases_channel_id` |
| `bundle_totals` (aggregate) | `platform_key`, `_shard` | — | New. Counter `bundles`; `platform_key` is `*` or a platform |
| `base_candidates` (aggregate) | `candidate_key`, `bundle_id`, `_shard` | `byKey [candidate_key; bundle_id]` | New. Gauge `releases`, deleted at zero; the key is channel + platform + fingerprint, or channel + platform + minor line (up to 16 per release) |

### Insights (`schema.insights`)

| Table | Key | Indexes | Change against `v1_0_0.ts` |
|---|---|---|---|
| `bundle_events` | `id` | `recent [channel, platform, day; received_at_ms]`; `movementsByInstall [movement_install_id; received_at_ms]`; `byBundle [platform, channel, type, bundle_ref, day; received_at_ms]` | + `_v`; derived `day` (UTC day start in ms), `movement_install_id` (`install_id` for `UPDATE_DOWNLOADED`, `UPDATE_APPLIED`, `RECOVERED`, else null), multi-valued `bundle_ref` (`from:<id>`, `to:<id>`); the five current indexes are replaced; `metadata` is kept |
| `bundle_event_heads` | `install_id` | `byUser [user_id; install_id]` | + `_v`; keeps all 11 columns; the scope, from, and to indexes are dropped. Firestore's `insights_latest` becomes this table |
| `insights_overview` (aggregate) | `identity`, `bucket_start_ms`, `_shard` | — | Re-keyed from the 32-hex `id`. Counters `downloads`, `launches`, `failed_launches`; `identity` encodes scope and period (hour rows, plus day rollups for channel and usage); `latest_installations`, `launch_users`, and `activity_users` move out |
| `insights_sketches` (aggregate) | `identity`, `bucket_start_ms`, `_shard` | — | New. Distinct `launch_users`, `activity_users` (HLL) in rows separate from counters |
| `insights_distribution` (aggregate) | `channel`, `platform`, `app_version`, `release_id`, `bucket_start_ms`, `_shard` | `[channel, platform; bucket_start_ms]`, `[channel, platform, app_version; bucket_start_ms]` | New. Gauge `latest_installations`, sharded by install id |
| `insights_latest_by_bundle` (aggregate) | `platform`, `channel`, `bundle_field`, `bundle_id`, `type`, `bucket_start_ms`, `_shard` | — | New. Gauge `installations` per hour bucket |
| `insights_outcomes` (aggregate) | `platform`, `channel`, `type`, `bundle_ref`, `bucket_start_ms`, `_shard` | — | New. Counter `events` per hour bucket |

### API keys (`schema.apiKeys`)

| Table | Key | Indexes | Change against `v1_0_0.ts` |
|---|---|---|---|
| `api_keys` | `id` | `hash` unique; `byCreated [; created_at_ms]` | + `_v`; columns unchanged, including `prefix` and `role` |

### Settings

`private_hot_updater_settings(key, value)`, keys from [decision 3](#3-module-keys), is written
only by migrations and read only by the fence.

## Per-backend delta

| Backend | Storage | Fence location | Also changes |
|---|---|---|---|
| PostgreSQL, MySQL, SQLite (Kysely, Drizzle, Prisma, Postgres plugin, PGlite, libSQL) | One table per resolved table, plus `bundle_events__byBundle` | Rows in `private_hot_updater_settings` | Declared indexes only; MSSQL and CockroachDB variants removed (E2); DB foreign keys until E2 |
| Cloudflare D1 | As SQLite; `bundle_events.insights_processed` is removed | Same | D5's guard statement (`_hu_write`) |
| Supabase | As PostgreSQL with `hot_updater_v1_` | Rows in `hot_updater_v1_private_hot_updater_settings` | `hot_updater_v1_commit`, `_delete_channel`, and `_record_event` are replaced by one `SECURITY INVOKER` apply RPC (D6) |
| MongoDB | One collection per resolved table | Documents in `private_hot_updater_settings` (unique `key`) | Multikey index for `bundle_ref`; validators regenerated; `_c` for checks |
| DynamoDB | One table (`pk`, `sk`), KV items | Item `pk = private_hot_updater_settings`, `sk = enc(key)` | GSI dropped (D8); IAM `dynamodb:LeadingKeys` and `e2e-service.sh` follow the new partitions |
| Firestore | One collection `hot_updater_v1` of `{ pk, sk, row }` | Document with `pk = private_hot_updater_settings` | `database_adapter_version` `{version: 4}` and the channel-id registry documents are removed; `firestore.indexes.json` shrinks to the `(pk, sk)` index (D9) |

## Decided later

- KV key encoding (`enc`) and item sizes: D7.
- D1's guard statement and its helper table: D5.
- The Supabase apply RPC's signature and allowlist: D6.
- Firestore index directions: D9, against the emulator.
- Shard counts (default 8 for channel and usage rows, otherwise 1): confirmed by B3 and D8.

## Sign-off

- [ ] The owner approves decisions 1–10. A change after sign-off is logged as a new row in the
      PRD's Review decisions table.
