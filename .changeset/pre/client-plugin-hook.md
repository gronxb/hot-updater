---
"@hot-updater/server": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
---

A server plugin names the client plugin an app adds to `HotUpdater.init`'s `plugins` in `cli.clientPlugin`, as `{ module, name }`; `insights()` names `insights` from `@hot-updater/react-native/plugins/insights`. `createHotUpdater` checks them at startup: each names an export the app can import, not a reserved word, `App`, or `HotUpdater`, and no two plugins name one export from different modules. `@hot-updater/server/db` exports `clientPluginsOf`, which reads them from a plugin list. Managed init passes them to `printAppSetup`, which imports them and adds them to `plugins`, and agent scaffolds record them in `manifest.json` and render the app code in their instructions from them.
