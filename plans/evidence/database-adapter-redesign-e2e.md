# Database adapter redesign: final E2E run

Recorded on 2026-09-29 (UTC) for PRD "Final acceptance" S5. Every run is `hot-updater-agent verify -platform full`
against the shared env-target `examples/v0.85.0/.env.hotupdater`, on `4f6df91f0`, the top of the stack (#1381).
`database-redesign-e2e.json`, next to this file, holds the same runs for the acceptance report.

| Profile | Task id | Runtime | Finished (UTC) | Duration |
|---|---|---|---|---|
| `standalone-kysely` | `job-20260928233836-v6yucm` | Built by the job | 2026-09-29 00:31 | 29m5s |
| `standalone-drizzle` | `job-20260929050159-6igza1` | Built by the job | 2026-09-29 05:26 | 24m22s |
| `standalone-prisma` | `job-20260929010332-0ry1re` | Built by the job | 2026-09-29 02:16 | 26m21s |
| `standalone-mongodb` | `job-20260929021621-mxikru` | Built by the job | 2026-09-29 02:45 | 29m10s |
| `standalone-dynamodb` | `job-20260929043202-jyssdu` | Built by the job | 2026-09-29 05:01 | 29m46s |
| `supabase` | `job-20260929052635-0iivs6` | Edge Function version 15 | 2026-09-29 06:18 | 51m29s |
| `cloudflare` | `job-20260928191543-t3ylja` | Worker version `16156fd9-ff36-42f5-a0da-486165d61128` | 2026-09-28 20:34 | 50m48s |
| `firebase` | `job-20260929034431-pzrykv` | Function source hash (`firebase-functions-hash`) `ccb7822bffb20f9764ec7324c92ddfb1aa97bfef` | 2026-09-29 04:29 | 44m40s |
| `aws` | `job-20260929004057-i0f7ld` | Lambda@Edge version 22 | 2026-09-29 01:49 | 46m22s |

## Managed runtimes

The four managed runtimes run on the existing resources. Each release candidate database was recreated for this
stack following `plans/database-adapter-redesign/managed-e2e-runbook.md` (#1345), and the schema has not changed
since, so this round recreated none. The runtimes were redeployed from `4f6df91f0` scaffolds
(`hot-updater agent infra upgrade --build bare`), with the resource identifiers of the previous deployment filled in,
and each passed the scaffold's `verify-server` check before its run.

Each managed profile reads its resource identifiers from the e2e bot's profile, and those can differ from the
repository's env-target. The Cloudflare profile's D1 database does: the Worker is bound to the profile's database.

## Every managed run

| Profile | Task id | Commit | Result | Cause |
|---|---|---|---|---|
| `cloudflare` | `job-20260926214004-agw9fj` | `24bc70f74` | failed | The Worker was bound to the env-target's D1 database, not the profile's. The profile's database was recreated and the Worker rebound (`4656076f`). |
| `supabase` | `job-20260926214759-zk32qw` | `24bc70f74` | failed | 52 of 54 scenario runs failed at "verify Console Insights" with HTTP 404: the example app had no `hotUpdater.plugins.ts` (fixed in `056dd7039`). |
| `firebase` | `job-20260926224126-4r01oj` | `24bc70f74` | failed | Same Insights failure as supabase. |
| `aws` | `job-20260926232723-77kwm4` | `24bc70f74` | failed | The AWS SSO session on the e2e machine had expired. |
| `cloudflare` | `job-20260927030038-hix4ch` | `f8bae42db` | passed | |
| `supabase` | `job-20260927034626-nte9es` | `f8bae42db` | failed | One of 54 scenario runs: Supabase Storage answered an upload with an HTML error page. `supabaseStorage` differs from `next` only by a type parameter. |
| `firebase` | `job-20260927044113-qu163p` | `f8bae42db` | passed | |
| `supabase` | `job-20260927052715-f88x69` | `f8bae42db` | passed | |
| `aws` | `job-20260927071930-sg5esb` | `f8bae42db` | passed | |
| `cloudflare` | `job-20260928080526-jmmn31` | `fc4f3db52` | failed | 11 of 54 scenario runs timed out: Worker answers took 15-35 s from 17:20 to 17:52 (D1 queries stayed under 1 ms), during Cloudflare's open Asia-Pacific network degradation. |
| `cloudflare` | `job-20260928104252-zztx83` | `fc4f3db52` | failed | 16 of 54 scenario runs timed out the same way, from 19:52 to 20:38. |
| `cloudflare` | `job-20260928122904-i9uuy4` | `fc4f3db52` | cancelled | Cancelled after 3 early failures of the same kind; the stack's head moved on. |
| `supabase` | `job-20260928085923-zbeeji` | `fc4f3db52` | passed |  |
| `firebase` | `job-20260928095631-hw4x80` | `fc4f3db52` | passed |  |
| `aws` | `job-20260928114223-5enwqt` | `fc4f3db52` | passed |  |
| `aws` | `job-20260928203423-gz1ox8` | `4f6df91f0` | failed | Every scenario stopped at bootstrap: the AWS SSO session on the e2e machine had expired after the Lambda@Edge deploy. After the owner's login, the session was refreshed every 30 minutes. |
| `supabase` | `job-20260928211519-gp30a6` | `4f6df91f0` | failed | 2 of 54 scenario runs: Supabase Storage answered a bundle upload with an HTML error page, and one large archive download from Supabase Storage stalled past the 60 s wait (it takes about 10 s). |
| `firebase` | `job-20260928221527-9qq6b0` | `4f6df91f0` | failed | 2 of 54 scenario runs: adb failed on the Android emulators (`adb reverse` protocol fault, listener not found); the emulators went offline later that morning. |
| `supabase` | `job-20260929025034-xvq21t` | `4f6df91f0` | failed | 1 of 54 scenario runs: the same large archive download from Supabase Storage stalled past 60 s; every Insights report of the run had answered within 2 s. |
| `cloudflare` | `job-20260928191543-t3ylja` | `4f6df91f0` | passed | |
| `supabase` | `job-20260929052635-0iivs6` | `4f6df91f0` | passed | |
| `firebase` | `job-20260929034431-pzrykv` | `4f6df91f0` | passed | |
| `aws` | `job-20260929004057-i0f7ld` | `4f6df91f0` | passed | |
