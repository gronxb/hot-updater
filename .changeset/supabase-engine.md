---
"@hot-updater/server": patch
"@hot-updater/supabase": minor
---

Run Supabase on the new storage engine. `supabaseDatabase({ supabaseUrl, supabaseServiceRoleKey })` keeps its signature.

- **One RPC:** every read and write goes through `hot_updater_v1_apply(p_statements jsonb)`. It runs the SQL core's statements in the caller's transaction, so a write, sent as one batch, commits atomically. The engine's batch writes lock the rows their guards read on PostgreSQL, so no writer moves them before the batch commits.
- **Security:** the function runs `SECURITY INVOKER` with a fixed `search_path`. `EXECUTE` is revoked from `PUBLIC`, `anon`, and `authenticated`, and granted to `service_role` only. It allows only the SQL core's statement shapes on Hot Updater's tables: one `SELECT`, `INSERT`, `UPDATE`, or `DELETE` each, with no literal, comment, semicolon, function call, or other word. Values never enter the SQL: each is read from one jsonb parameter, typed, as `($1->>k)::bigint`.
- **Schema:** the single `20260818000000_hot-updater_1.0.0.sql` migration is now the generated shared SQL schema under the `hot_updater_v1_` prefix. It adds the write guard, row-level security on every table, the RPC, and the settings rows, last. The old commit, channel-deletion, and event RPCs and their follow-up migration are removed.
- **Schema fence:** the adapter fences its schema. A project without the migration answers 503, including when PostgREST cannot find the RPC. `hot-updater init` reports an RC database from before the engine as incompatible.
