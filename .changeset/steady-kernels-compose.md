---
"@hot-updater/analytics": minor
"@hot-updater/aws": minor
"@hot-updater/better-auth": minor
"@hot-updater/cloudflare": minor
"@hot-updater/cli-tools": minor
"@hot-updater/console": minor
"@hot-updater/firebase": minor
"@hot-updater/plugin-core": minor
"@hot-updater/postgres": minor
"@hot-updater/server": minor
"@hot-updater/standalone": minor
"@hot-updater/supabase": minor
---

Introduce the generic server plugin kernel and publish first-party Analytics
and Better Auth feature packages. This is a coordinated breaking source
migration. These packages are pre-1.0, so the repository releases the change
as a minor version.

Migrate server construction as follows:

- Replace `routes.updateCheck` and `routes.bundles` with `coreRoutes`.
  Bundle-management routes are protected by default; use
  `bundles: { access: { kind: "public" } }` only when public compatibility is
  intentional.
- Replace `routes.analytics` with an Analytics provider capability and
  `plugins: [analytics()]`. Import the feature factory and public Analytics
  API/domain types from `@hot-updater/analytics`, and import provider authoring
  from `@hot-updater/analytics/provider`.
- Read Analytics through `hotUpdater.features.analytics`. The temporary flat
  operation aliases remain only in the available branch for the announced
  migration window. Default/warn mode must be narrowed by `status`; strict
  `missingCapability: "error"` construction is available-only.
- Use `createLegacyHotUpdater` from
  `@hot-updater/analytics/legacy-server` only as the temporary bridge for the
  old `routes.analytics` spelling. The supported server root rejects
  `routes.analytics` and `routes.eventIngestion`.
- Replace high-level Analytics services and capability symbols formerly
  imported from `@hot-updater/server` or `@hot-updater/plugin-core` with the
  Analytics package. Plugin-core now exposes only generic capability carriers
  plus neutral raw persistence models.

Protected routes now require exactly one authentication provider. Install
`betterAuthPlugin({ auth })` from `@hot-updater/better-auth` to adapt a
configured Better Auth instance; `better-auth` remains an optional peer.

CLI config loading now keeps plugin-core capability identity aligned while it
evaluates TypeScript, ESM, or CommonJS config files. This adds `jiti` and
`@hot-updater/analytics` as direct `@hot-updater/cli-tools` runtime
dependencies; Analytics is the current feature-token owner registered in the
canonical mixed-module config bridge.

Cloudflare, Firebase, and Supabase presets install strict public Analytics,
PostgreSQL and standalone expose Analytics providers, and AWS deliberately
remains core-only without Analytics capability or warnings. Publish this
package cohort together so provider presets, kernel declarations, and
condition-specific ESM/CommonJS exports stay aligned.
