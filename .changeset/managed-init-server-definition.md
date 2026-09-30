---
"hot-updater": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

`hot-updater init` writes the managed server's definition, `hotUpdater.ts`, with the provider's database and storage and the plugins the managed server runs, and points `server` in `hot-updater.config.ts` at it; it installs `@hot-updater/server`, which the definition imports. Rerunning init keeps a `server` the config already sets, keeps a definition the project wrote, and updates an older config, moving its database and storage out. A definition init wrote with other AWS credentials is replaced.
