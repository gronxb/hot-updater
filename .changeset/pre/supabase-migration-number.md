---
"@hot-updater/supabase": minor
---

The managed Supabase migration is `0001_hot-updater_1.0.0.sql`, numbered like the Cloudflare D1 one instead of dated, so later versions apply in the order of their numbers. A release candidate deployment that applied `20260818000000_hot-updater_1.0.0.sql` recreates its database before rerunning `hot-updater init`, as the 1.0.0 upgrade note says. Migrations that `hot-updater db generate` writes keep their timestamps.
