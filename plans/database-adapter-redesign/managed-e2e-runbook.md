# Managed-profile E2E runbook

Stack 0.3 of the database adapter redesign. Owner decision (PRD review decision 35,
2026-09-23, superseding 34): E2E runs the `standalone-*` profiles by default. The four managed
profiles (`aws`, `cloudflare`, `firebase`, `supabase`) reuse the existing infrastructure and the
existing env-target `examples/v0.85.0/.env.hotupdater`, and run only when a change is ready. No
dedicated infrastructure is created.

## When each profile runs

| Stage | Standalone profiles | Managed profiles |
|---|---|---|
| Runtime PRs D1–D4, D7, E1a–E1d | The mapped profile | None |
| D5 (Cloudflare D1) | — | `cloudflare`, once the PR is ready |
| D6 (Supabase) | — | `supabase`, once the PR is ready |
| D8 (DynamoDB) | `standalone-dynamodb` | `aws`, once the PR is ready |
| D9 (Firestore) | — | `firebase`, once the PR is ready |
| E2 | All five | All four, once the PR is ready |
| Final gate (top branch after E4) | All five | All four; all nine on one commit |

A PR is ready when its local suites and GitHub CI are green, its standalone profile (if any)
passed, and review findings are resolved. A managed run is the last check, not a debugging loop:
reproduce a managed failure locally or with a standalone profile before running it again.

## Before a managed run

1. The runtime and database behind a managed profile are shared by every PR. Check
   `hot-updater-agent status -limit 20` and wait until no job for another PR is queued or running
   on that profile.
2. Tell the owner which runtime will be redeployed and which database recreated, and on which
   commit. Recreating a database is destructive; the AWS table also needs deletion protection
   lifted (below), which needs the owner's go-ahead each time.
3. Build the stack commit (`pnpm install --frozen-lockfile && pnpm build`) and scaffold into a
   fresh directory outside the repository:
   `node packages/hot-updater/dist/index.mjs infra scaffold --provider <provider> --output <dir>/<provider>-<short-sha>`.
   Read the scaffold's `upgrades/1.0.0.md` and follow
   `.agents/skills/hot-updater/references/infrastructure.md`.
4. Fill scaffold inputs from the env-target's resource identifiers. Load secrets privately; never
   print them or pass them as command arguments.

## Redeploy onto the existing resources

The redesign recreates RC databases (PRD decision 7), so each run starts from an empty v1 schema.
D5, D6, D8, and D9 replace the database steps below with their exact commands.

| Provider | Recreate the database | Deploy the runtime |
|---|---|---|
| Cloudflare | Drop the Hot Updater tables and `d1_migrations` in the existing D1 database, then from `worker/` run `npx wrangler d1 migrations apply <database> --remote` | `npm run deploy` from `worker/` with `wrangler.json` set to the existing account, Worker, D1, and R2; keep the existing `STORAGE_DOWNLOAD_URL_SIGNING_KEY` |
| Supabase | Drop the `hot_updater_v1_*` tables and functions and their rows in `supabase_migrations.schema_migrations`, then `npx supabase db push --include-all --yes` | Deploy the `hot-updater-v1` Edge Function with the scaffold's steps |
| Firebase | Delete the Hot Updater collections with `npx firebase firestore:delete --recursive <collection> --project <project>`, deploy `firestore:indexes`, then run the key helper, which writes the fence | `npx firebase deploy --only functions:hot-updater-v1 --project <project>` |
| AWS | Lift deletion protection, delete the table, create it from the scaffold's `dynamodb/create-table.json`, then restore PITR and deletion protection | Publish a new numbered Lambda@Edge version, associate it with the existing CloudFront distribution, and invalidate |

Then register the saved client API key with the scaffold's key helper (reuse it; never rotate)
and run the scaffold's `app/verify-server.mjs` against the actual endpoint.

## Run and record

```bash
hot-updater-agent verify -platform full -profile <profile> -env-target examples/v0.85.0/.env.hotupdater
```

Read a failure with `hot-updater-agent reason <task-id> -tail 240`. Record every managed run in
`plans/evidence/database-adapter-redesign-e2e.md`: profile, task id, commit SHA, deployed runtime
identifier (Worker version, Edge Function version, Function revision, or Lambda version), date,
and result. Evidence counts only when the verified tree equals the PR's tree.

## After the run

Until the owner merges the switching PR, other PRs still expect `next`'s runtime and schema.
Redeploy the runtime from `origin/next` and recreate its database in `next`'s schema with the
same steps, unless the owner says to leave the stack's runtime in place. Tell the owner which
state the shared profile is in.

## Baselines

The managed baselines are the green runs recorded before A1 in
`plans/evidence/database-adapter-redesign-baseline.md` (added by A0, #1343); no separate baseline
run is needed.
