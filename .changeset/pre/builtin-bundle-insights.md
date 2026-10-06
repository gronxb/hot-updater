---
"@hot-updater/protocol": patch
"@hot-updater/react-native": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
---

Report installations on the built-in bundle. A client plugin's context has `minBundleId`, the ID of the bundle the native build ships, and the Insights client sends it with each report. Insights counts an installation that runs its build's built-in bundle again in the new `insights_builtin_distribution` gauge, by the release it runs and the bundle's ID, and `getAppUsage` returns `builtinBundleId` with each `bundleDistribution` row. The Console's **Distribution** shows **Built-in app** with the bundle ID under its app version, where it showed **Unknown bundle**, and event and installation details mark the built-in bundle. Reports from SDKs that do not send `minBundleId` count as before.

The Insights schema version stays 1.0.0 while the 1.0.0 baseline gains the `insights_builtin_distribution` table; existing tables don't change. On SQL databases, create it as the baseline does (Supabase prefixes it with `hot_updater_v1_` and enables row level security); Drizzle and Prisma projects regenerate their schema with `hot-updater db generate` and migrate it. On AWS the DynamoDB policy allows the new partition: rerun `hot-updater init`. Firestore and MongoDB need no change. Installations count in it from their first report after the upgrade.
