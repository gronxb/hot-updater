---
"@hot-updater/server": minor
"@hot-updater/cli-tools": minor
"@hot-updater/aws": minor
"@hot-updater/azure": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
"@hot-updater/vercel": minor
"hot-updater": minor
---

feat: make `insights()`, `apiKeys()`, and `remoteConfig()` optional on managed servers.

- **Init:** `hot-updater init` asks which of the three plugins the managed server runs, with all three selected. `--from-env-file` reads `HOT_UPDATER_PLUGINS`, a comma-separated list such as `insights,remoteConfig`, or `none`. Init saves the selection to `.env.hotupdater` and reuses it when a later run names none; with none saved or given, the server runs all three. Init deploys the server with the selection, lists the same plugins in `hot-updater.config.ts`, and prints the app setup for them. Run init again to change it.
- **Servers:** the prebuilt AWS, Azure, Cloudflare, Firebase, Supabase, and Vercel servers run the selected plugins. Without `apiKeys()`, client routes are public. A server deployed without a selection runs all three, as before.
- **Database:** init still creates the tables and schema settings of all three plugins, so turning one on later is only a rerun of init.
- **`@hot-updater/server/plugins`:** adds `managedPlugins(selection)`, `parseManagedPlugins`, `formatManagedPlugins`, and `MANAGED_PLUGIN_IDS`.
- The agent infrastructure scaffold still runs all three plugins. On Azure and Vercel, whose servers read the selection from a setting, its instructions remove a `HOT_UPDATER_PLUGINS` setting an earlier init left on the target.
