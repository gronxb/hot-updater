---
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/cloudflare": minor
"@hot-updater/supabase": minor
"@hot-updater/plugin-core": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/azure": patch
"@hot-updater/postgres": patch
"@hot-updater/vercel": patch
"@hot-updater/standalone": patch
"@hot-updater/console": patch
---

`hot-updater doctor --fix` is removed. Doctor only reports and writes nothing, and each issue names the command or edit that resolves it in `resolution` and `commands`. The flag is gone like any unknown option, and `--json` output has no `fixes` and no `fixability`. Run instead:

| Issue | Run |
| --- | --- |
| `SCHEMA_MIGRATION_PENDING` on a deployment `hot-updater init` created | `npx hot-updater init --provider <provider> --from-env-file .env.hotupdater`, which migrates the database and redeploys the server back to back |
| `SCHEMA_MIGRATION_PENDING` on a server of your own | `npx hot-updater db migrate <server file>` in the server's project, or `npx hot-updater db generate <server file>` and the database's tooling for Drizzle, Prisma, D1, and Supabase |
| `MISSING_FINGERPRINT_JSON`, `FINGERPRINT_JSON_STALE`, `FINGERPRINT_ENGINE_UNRECORDED` | `npx hot-updater fingerprint create` |
| `FINGERPRINT_JSON_UNUSED` | Delete `fingerprint.json`, then rebuild the apps |
| `MISSING_PUBLIC_KEY`, `PUBLIC_KEY_MISMATCH` | `npx hot-updater keys export-public`, then rebuild and release the app; installed apps keep the previous key |
| `RELEASE_CATALOG_STALE` | Any release change in the scope, such as `npx hot-updater deploy` or `npx hot-updater bundle update <id>`, which recompiles its catalog |

- Doctor detects a deployment `hot-updater init` created from the provider `.env.hotupdater` records, when the config's database is the one init saved: each provider's database factory now marks the resource it reaches, without credentials, and doctor compares it with the saved inputs. A database that reaches another resource gets your own server's commands; when doctor cannot tell, it names both, each with its condition. For it, a pending schema and an outdated server (`--server-base-url`) both name init with its saved inputs: it applies the release's migrations and then redeploys the Worker, Edge Function, Lambda@Edge function with its IAM role policy, Cloud Function, Vercel Function, or Function App, so the 503 window is the deploy. An outdated server of your own names `db migrate` and `db generate`, and doctor prints the reason beside the commands.
- `UNREFERENCED_ARTIFACTS` and `ARTIFACTS_UNCHECKED` are no longer reported: core deletes an artifact record with the last release that uses it, so it never leaves one behind.
- A stale release catalog only follows an edit made outside Hot Updater or a partial restore, since every release change writes its scope's catalog; doctor still reports it, as devices read the catalog.
- `@hot-updater/cloudflare/init` and `@hot-updater/supabase/init` no longer export `migrateDatabase`, and `@hot-updater/cli-tools` no longer exports `MigrateManagedDatabase`. `d1Database` and `supabaseDatabase` mark their target under the shared `Symbol.for("@hot-updater/database-target")` instead of their own symbols.
- The schema fence's errors, the standalone repository's 503 error, and the Console's migration notice send you to `npx hot-updater doctor`, which names the command for the database.
