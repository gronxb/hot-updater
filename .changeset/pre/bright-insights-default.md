---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/react-native": minor
"@hot-updater/console": minor
"@hot-updater/test-utils": minor
"@hot-updater/cli-tools": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/mock": minor
"@hot-updater/postgres": minor
"@hot-updater/standalone": minor
"@hot-updater/supabase": minor
"hot-updater": minor
---

Rename the built-in Analytics domain to Insights across the database model,
server provider and HTTP query route, React Native option and transport,
Console route and UI, and provider contracts. This is a breaking pre-release
rename with no compatibility aliases; use `database.models.insights`,
`createInsightsProvider`, `/bundles/:id/events/insights`, and `insights`.

Enable React Native Insights reporting by default for both `HotUpdater.init`
and `HotUpdater.wrap`. Set `insights: false` to opt out.
