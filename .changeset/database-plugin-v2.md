---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"hot-updater": minor
"@hot-updater/cli-tools": minor
"@hot-updater/console": minor
"@hot-updater/cloudflare": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
"@hot-updater/firebase": minor
"@hot-updater/mock": minor
"@hot-updater/standalone": minor
"@hot-updater/aws": minor
"@hot-updater/react-native": minor
---

Implement the database plugin v2 resource runtime. Database providers now use
the `name + connect(config)` authoring surface and expose first-class
`bundles`, `bundlePatches`, and optional `bundleEvents` resources; deploy,
bundle management, rollback, promote, console, standalone, server handler, and
React Native app-ready telemetry paths now persist through the v2 runtime
commit boundary.
