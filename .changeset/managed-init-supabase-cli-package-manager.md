---
"@hot-updater/supabase": patch
"@hot-updater/cli-tools": patch
---

Fix two managed `hot-updater init` failures.

- Supabase: init runs Supabase CLI 2.122.1 (`npx -y supabase@2.122.1`) and passes `--linked` to `db push`. Supabase CLI 3.0 sends an untargeted `db push` to the local stack, which failed every Supabase init with a connection error on 127.0.0.1:54322, and fails an unattended `functions deploy` without `--yes`.
- Installing a missing package such as `vercel` uses the project's package manager: the nearest `packageManager` field or lockfile, then the one that ran the CLI. `npx hot-updater init` in a pnpm workspace ran `npm install`, which fails on `workspace:` dependencies.
