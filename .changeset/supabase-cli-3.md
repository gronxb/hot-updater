---
"@hot-updater/supabase": patch
---

Run Supabase managed init on Supabase CLI 3.0.0 instead of 2.122.1. Init and
the agent setup guide now pass `--remote` to `migration fetch` and `db push`,
`--remote=<ref>` to `functions deploy`, `functions list` and
`projects api-keys`, the project ref as `link`'s argument, and `--yes` to
`functions deploy` and `projects create`, which CLI 3 refuses without a
terminal otherwise.
