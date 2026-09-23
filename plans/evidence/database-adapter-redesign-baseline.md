# Database adapter redesign: E2E baseline

Recorded on 2026-09-23 (KST), before A1, with `hot-updater-agent status -latest-success-by-profile -limit 20`
(PRD "Final acceptance", end-to-end gate step 1). Every run is `-platform full` against the shared
env-target `examples/v0.85.0/.env.hotupdater`. `origin/next` was at `c98d441b3`.

| Profile | Task id | Source | Commit | Finished (UTC) | Duration |
|---|---|---|---|---|---|
| `standalone-kysely` | `job-20260922092336-gpvjad` | #1319 | `7f5354318` | 2026-09-22 11:26 | 32m28s |
| `standalone-drizzle` | `job-20260922050045-t2qrzv` | #1319 | `303236ae0` | 2026-09-22 09:01 | 32m7s |
| `standalone-prisma` | `job-20260922045915-fh21v6` | #1319 | `303236ae0` | 2026-09-22 06:19 | 41m12s |
| `standalone-mongodb` | `job-20260922054627-jkktt2` | #1319 | `a2d980507` | 2026-09-22 09:33 | 32m12s |
| `standalone-dynamodb` | `job-20260922045914-4t8gad` | #1319 | `303236ae0` | 2026-09-22 05:38 | 32m2s |
| `supabase` | `job-20260922092342-qjx58f` | #1319 | `7f5354318` | 2026-09-22 12:24 | 57m47s |
| `cloudflare` | `job-20260922045915-4t4khc` | #1319 | `303236ae0` | 2026-09-22 07:11 | 51m29s |
| `firebase` | `job-20260922092336-usakef` | #1319 | `7f5354318` | 2026-09-22 10:54 | 1h14m51s |
| `aws` | `job-20260910042704-x6yrds` | #1293 | `d0ab9fc1b` | 2026-09-10 05:12 | 45m41s |

The eight runs from #1319 cover the tar.br manifest work that `next` merged as `79c3eea5a`.
`aws`'s latest green run is older (#1293, 2026-09-10). Stack 0.3 re-baselines the four managed
profiles (cloudflare, supabase, firebase, aws) on dedicated infrastructure before D5.
