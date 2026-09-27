# Database adapter redesign: final E2E run

Recorded on 2026-09-27 (KST) for PRD "Final acceptance" S5. Every run is `hot-updater-agent verify -platform full`
against the shared env-target `examples/v0.85.0/.env.hotupdater`, on `f8bae42db`, the top of the stack (#1381).
`database-redesign-e2e.json`, next to this file, holds the same runs for the acceptance report.

| Profile | Task id | Runtime | Finished (UTC) | Duration |
|---|---|---|---|---|
| `standalone-kysely` | `job-20260927004257-frf7c0` | Built by the job | 2026-09-27 01:13 | 30m9s |
| `standalone-drizzle` | `job-20260927011314-bzr6ij` | Built by the job | 2026-09-27 01:38 | 25m7s |
| `standalone-prisma` | `job-20260927013829-g0y21i` | Built by the job | 2026-09-27 02:03 | 24m59s |
| `standalone-mongodb` | `job-20260927020335-55ndnh` | Built by the job | 2026-09-27 02:30 | 26m30s |
| `standalone-dynamodb` | `job-20260927023012-7o7a1r` | Built by the job | 2026-09-27 03:00 | 30m16s |
| `supabase` | `job-20260927052715-f88x69` | Edge Function version 10 | 2026-09-27 06:15 | 48m27s |
| `cloudflare` | `job-20260927030038-hix4ch` | Worker version `4656076f-493d-4984-8524-cd6586bca90d` | 2026-09-27 03:46 | 45m37s |
| `firebase` | `job-20260927044113-qu163p` | Function revision `4fe6718ead84d2b0e4465bb1ead78d2820b78532` | 2026-09-27 05:26 | 45m33s |
| `aws` | `job-20260927071930-sg5esb` | Lambda@Edge version 18 | 2026-09-27 08:02 | 43m27s |

## Managed runtimes

The four managed runtimes were deployed onto the existing resources after each release candidate database was
recreated, following `plans/database-adapter-redesign/managed-e2e-runbook.md` (#1345). They were deployed from
`8768721b2` scaffolds (`hot-updater agent infra upgrade --build bare`). No file under `packages/` or `plugins/`
changed between `8768721b2` and `f8bae42db`, and scaffolds from a later head differ from the deployed ones only in
the filled-in resource identifiers.

Each managed profile reads its resource identifiers from the e2e bot's profile, and those can differ from the
repository's env-target. The Cloudflare profile's D1 database does: the release candidate Worker was bound to it, so
that database is the one recreated.

## Every managed run

| Profile | Task id | Commit | Result | Cause |
|---|---|---|---|---|
| `cloudflare` | `job-20260926214004-agw9fj` | `24bc70f74` | failed | The Worker was bound to the env-target's D1 database, not the profile's. The profile's database was recreated and the Worker rebound (`4656076f`). |
| `supabase` | `job-20260926214759-zk32qw` | `24bc70f74` | failed | Every scenario failed at "verify Console Insights" with HTTP 404: the example app had no `hotUpdater.plugins.ts` (fixed in `056dd7039`). |
| `firebase` | `job-20260926224126-4r01oj` | `24bc70f74` | failed | Same Insights failure as supabase. |
| `aws` | `job-20260926232723-77kwm4` | `24bc70f74` | failed | The AWS SSO session on the e2e machine had expired. |
| `cloudflare` | `job-20260927030038-hix4ch` | `f8bae42db` | passed | |
| `supabase` | `job-20260927034626-nte9es` | `f8bae42db` | failed | One of 54 scenario runs: Supabase Storage answered an upload with an HTML error page. `supabaseStorage` differs from `next` only by a type parameter. |
| `firebase` | `job-20260927044113-qu163p` | `f8bae42db` | passed | |
| `supabase` | `job-20260927052715-f88x69` | `f8bae42db` | passed | |
| `aws` | `job-20260927071930-sg5esb` | `f8bae42db` | passed | |
