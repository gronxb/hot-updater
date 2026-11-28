---
"@hot-updater/supabase": patch
"@hot-updater/firebase": patch
"@hot-updater/cli-tools": patch
---

Fix three managed `hot-updater init --from-env-file` failures.

- Supabase: init runs Supabase CLI 2.122.1 (`npx -y supabase@2.122.1`) and passes `--linked` to `db push`. Supabase CLI 3.0 sends an untargeted `db push` to the local stack, which failed every Supabase init with a connection error on 127.0.0.1:54322, and fails an unattended `functions deploy` without `--yes`.
- Firebase: init migrates the database with the service account `GOOGLE_APPLICATION_CREDENTIALS` names in the env file, instead of the default app that loading `hot-updater.config.ts` had bound to Application Default Credentials. Before, init stopped with "Could not load the default credentials" unless the variable was exported in the shell.
- Installing a missing package such as `vercel` uses the project's package manager: the nearest `packageManager` field or lockfile, then the one that ran the CLI. `npx hot-updater init` in a pnpm workspace ran `npm install`, which fails on `workspace:` dependencies.
