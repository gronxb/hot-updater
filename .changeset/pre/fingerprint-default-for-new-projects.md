---
"hot-updater": patch
"@hot-updater/cli-tools": patch
"@hot-updater/aws": patch
"@hot-updater/azure": patch
"@hot-updater/cloudflare": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"@hot-updater/vercel": patch
---

New projects use the fingerprint update strategy by default.

- `hot-updater init` writes `updateStrategy: "fingerprint", // or "appVersion"` into a new `hot-updater.config.ts`, and the app code it prints checks with the same strategy: `hotUpdater.wrap({ updateStrategy: "fingerprint" })(App)`. It then writes `fingerprint.json`, which native builds embed and `deploy` targets; commit it. When it can't compute the fingerprint, it names `npx hot-updater fingerprint create` as the next step. Every provider's `init` and the agent scaffold's config use the same default.
- Init's output reads in order and ends with "Done! 🎉": the provider's steps, then the `fingerprint.json` step, then every next step (the provider's docs link, and any step the fingerprint left), then Done. Each provider's init returns its next steps instead of printing them and Done itself. Mixing package versions still works: with a provider package from before this change, which prints its own next step and Done, init still writes `fingerprint.json` and prints only the step it leaves, if any.
- Existing projects keep their strategy. Init never adds `updateStrategy` to a config that already exists, and a config that sets none still loads as `appVersion`, so upgrading doesn't retarget apps you already shipped. The app code init prints follows the config it merged into.
- To switch an existing project to fingerprint, set `updateStrategy: "fingerprint"`, run `npx hot-updater fingerprint create`, commit `fingerprint.json`, and release new native builds. To switch a new project to App Version, set `updateStrategy: "appVersion"` in the config and the app code, delete `fingerprint.json`, and build again. Either switch needs a new native build: builds made before it keep checking by their old strategy and receive no update deployed by the new one.
