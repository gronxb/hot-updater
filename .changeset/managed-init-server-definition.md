---
"hot-updater": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

`hot-updater init` writes the managed server's definition, `hotUpdater.ts`, with the provider's database and storage and the plugins the managed server runs, and points `server` in `hot-updater.config.ts` at it; it installs `@hot-updater/server`, which the definition imports. Rerunning init keeps a `server` the config already sets, keeps a definition the project wrote, and updates an older config, moving its database and storage out. A definition init wrote with other AWS credentials is replaced. Init writes the definition even when it cannot update the config, such as one that is not `export default defineConfig({ ... })`, and then says which `server` line to add and which keys to remove. It removes the `hotUpdater.plugins.ts` an older init wrote, and names one the project wrote, which nothing reads.
