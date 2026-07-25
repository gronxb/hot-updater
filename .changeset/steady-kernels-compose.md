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

- Keep `routes.updateCheck` and `routes.bundles` as the core route controls.
  Bundle-management routes are protected by default; use
  `bundles: { access: { kind: "public" } }` only when public compatibility is
  intentional.
- Replace `routes.analytics` with `plugins: [analytics()]`. The feature uses the
  guarded generic database runtime by default; database plugins no longer need
  an Analytics wrapper or capability contribution. Import explicit provider
  authoring from `@hot-updater/analytics/provider` only for dedicated
  transports.
- Read Analytics through `hotUpdater.features.analytics`. The temporary flat
  operation aliases remain for the announced migration window. Installing
  `analytics()` now yields the available feature API at construction time.
- Use `createLegacyHotUpdater` from
  `@hot-updater/analytics/legacy-server` only as the temporary bridge for the
  old `routes.analytics` spelling. The supported server root rejects
  `routes.analytics` and `routes.eventIngestion`.
- Replace high-level Analytics services and capability symbols formerly
  imported from `@hot-updater/server` or `@hot-updater/plugin-core` with the
  Analytics package. Plugin-core now exposes only generic capability carriers
  plus neutral raw persistence models.
- Remove `withAnalyticsProvider`, `analyticsProviderToken`,
  `MissingAnalyticsProviderCapability`, `UnavailableAnalyticsFeature`, and
  the `missingCapability` Analytics option. Database plugins no longer carry
  Analytics provider factories. Use `analytics({ provider })` for a dedicated
  provider or `standaloneAnalytics(config)` for the Standalone transport.

Protected routes now require exactly one authentication provider. Install
`betterAuthPlugin({ auth })` from `@hot-updater/better-auth` to adapt a
configured Better Auth session and protect every HTTP route emitted by
`createHotUpdater`. To use API keys, install Better Auth's
`@better-auth/api-key` plugin with `enableSessionForAPIKeys: true`; Hot Updater
then authenticates the API-key-backed session through `auth.api.getSession`.
There is no separate Hot Updater API-key mode or package.

CLI config loading now keeps plugin-core capability identity and first-party
manifest identity aligned while it evaluates TypeScript, ESM, or CommonJS
config files. This adds `jiti`, `@hot-updater/analytics`, and
`@hot-updater/server` as direct `@hot-updater/cli-tools` runtime dependencies.

Local Console Analytics is now disabled by default. Opt a complete generic
database into the bounded provider explicitly:

```ts
export default defineConfig({
  console: { analytics: "database" },
  database,
});
```

Standalone uses its dedicated feature manifest instead:

```ts
const standalone = { baseUrl: "https://updates.example.com" };

export default defineConfig({
  console: {
    analytics: standaloneAnalytics(standalone, { queryAccess: "public" }),
  },
  database: standaloneRepository(standalone),
});
```

AWS, Cloudflare, Firebase, and Supabase presets require the managed API key on
every route emitted by their `createHotUpdater` handler. They use the same
Better Auth session path as custom servers, with an ephemeral in-memory
managed projection of the provisioned API-key digest. Cloudflare, Firebase,
and Supabase also install protected Analytics over their bare database
plugins, including protected event ingestion; AWS deliberately remains
core-only because its preset omits Analytics. AWS disables shared caching and
forwards `x-api-key` on the authenticated update path. PostgreSQL keeps the
same database-backed Analytics default for custom composition. These managed
server presets are independent from the local Console opt-in.
`standaloneRepository(config)` remains Analytics-agnostic. Publish this
package cohort together so provider presets, authentication policy, kernel
declarations, and condition-specific ESM/CommonJS exports stay aligned.
