# Database adapter redesign: Supabase ingestion ceiling

Recorded on 2026-09-24 (KST) for D6 (PRD metric "Firestore and Supabase ingestion ceilings: measured and
recorded"). The measurement is the `records the Insights ingestion ceiling through the apply RPC` case of
`plugins/supabase/supabase/edge-functions/runtime.docker.integration.spec.ts`, which logs one
`supabase-ingestion-ceiling` JSON line:

```bash
pnpm exec vitest run --reporter=default --project integration:default plugins/supabase/supabase/edge-functions/runtime.docker.integration.spec.ts -t "ingestion ceiling"
```

The scenario is B3's rollout: each event moves one installation from release A to release B on one channel,
through the Insights plugin, the engine, the SQL core's batch writes, and the `hot_updater_v1_apply` RPC
over PostgREST v14.6 and Postgres 15. Each step first moves 600 installations onto A, then moves the same
600 from A to B at the offered rate, over 16 writers, with 5 ms added to every adapter call.

| Offered/s | Committed | Errors | Resends | Retried | Achieved/s |
|---|---|---|---|---|---|
| 50 | 600 | 0 | 9 | 1.5% | 50 |
| 100 | 600 | 0 | 15 | 2.5% | 100 |
| 200 | 600 | 0 | 231 | 28.7% | 84 |
| 400 | 600 | 0 | 228 | 27.8% | 107 |
| 800 | 600 | 0 | 222 | 29.0% | 93 |

**Ceiling: 100 moves per second**, the highest offered rate that was kept up with, no errors, and at most 5%
retried. Above it, throughput levels off near 100 moves per second, and about 28% of moves resend their
aggregate rows. Every move still commits. No step reran a transaction.

Host: Apple M4 (10 cores), Docker Desktop with 6 CPUs and 6 GB. Another integration suite was running on
the same host, so treat the figures as a lower bound for this setup. A managed project adds the network
round trip between the Edge Function and PostgREST, and its compute size sets the database's share.
