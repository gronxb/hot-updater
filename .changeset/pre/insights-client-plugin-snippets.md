---
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"hot-updater": patch
---

The `HotUpdater.init` snippet that managed `init` prints now adds the Insights client plugin, `plugins: [insights()]` from `@hot-updater/react-native/plugins/insights`, since an app reports to Insights only with it. The CLI's agent setup instructions add the same plugin.
