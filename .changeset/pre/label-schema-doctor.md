---
"hot-updater": patch
"@hot-updater/server": patch
"@hot-updater/cloudflare": patch
---

fix(doctor): report a database without release labels' schema as unchecked and name its repair, print each issue's commands, and renew an expired Wrangler login in Cloudflare init

- A dry run of the release label fill now reads one pair's counter and label index first. A database a 1.2 prerelease migrated, which lacks the `label` column or the `label_sequences` table, fails it with the database's error, instead of counting its releases as unlabeled.
- Doctor reports that failure as `RELEASE_LABELS_UNCHECKED` and names the repair: the three `wrangler d1 execute` statements on Cloudflare, the release's migration run again with `supabase db query` on Supabase, and the migration elsewhere. `RELEASE_LABELS_MISSING` stays for a migrated database whose releases lack labels.
- Doctor's plain output prints the commands an issue names under its resolution, unless the resolution already spells them out. A resolution ending in ":" was printed without its command.
- Cloudflare init renews an expired Wrangler login with `wrangler whoami` before it asks for `wrangler login`, so `init --from-env-file` no longer stops at "Cloudflare Wrangler login is required." on a machine that logged in before.
