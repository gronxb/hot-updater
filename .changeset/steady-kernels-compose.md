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
"@hot-updater/react-native": minor
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
  guarded generic database runtime by default. A first-party repository may
  advertise an internal transport capability without installing Analytics;
  there is no public provider-authoring option.
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
  public Analytics provider factories. `standaloneRepository(config)`
  advertises its private remote transport automatically, while `analytics()`
  remains the only operation that installs the feature.

Migrate React Native Analytics to the feature-owned client:

- Create the client with `createReactNativeAnalytics` from
  `@hot-updater/analytics/react-native`.
- Replace the React Native root `analytics` option with
  `analytics.recordAppReady(result)` in the existing `onNotifyAppReady`
  callback.
- Replace `HotUpdater.setUser` and `HotUpdater.getInstallId` with the client
  methods. The React Native root no longer exposes Analytics-specific options
  or identity helpers.
- Custom resolvers keep their generic `notifyAppReady` callback. Compose the
  Analytics client through `onNotifyAppReady`; do not add an
  Analytics-specific resolver callback.

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

The local Console now installs feature manifests through `console.plugins`.
Enable Analytics over a complete generic database explicitly:

```ts
export default defineConfig({
  console: {
    plugins: [analytics({ queryAccess: "public" })],
  },
  database,
});
```

Standalone uses the same Analytics manifest:

```ts
const standalone = { baseUrl: "https://updates.example.com" };

export default defineConfig({
  console: {
    plugins: [analytics({ queryAccess: "public" })],
  },
  database: standaloneRepository(standalone),
});
```

`console.plugins` configures only the local Console runtime. Its manifests are
not propagated into a managed preset, deployed handler, or separate
`createHotUpdater` plugin list. Omitting the array leaves the Console without
optional feature plugins; the former `"database"` and `"disabled"` sentinels
and `console.analytics` field are removed. Config loading rejects an own
`console.analytics` key with migration guidance for every supported JavaScript
and TypeScript module extension.

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
Managed key provisioning serializes concurrent writers with an owner-only lock
directory, rejects symbolic and multiple hard links, requires a user-owned
parent that is not group- or other-writable, rejects replaceable ancestors in
the requested and canonical root- or effective-user-owned directory chains,
rejects non-root-owned symbolic links, and verifies owner-only POSIX
permissions before writing the raw key. Existing keyless files are copied into
a fresh `0600` inode and atomically replaced, so pre-opened descriptors to the
old inode cannot observe the generated key. It fails closed on Windows or
filesystems that cannot prove the resulting ownership and mode.
`standaloneRepository(config)` contributes only an internal transport
implementation; it does not install Analytics or expose an Analytics option.
Publish this package cohort together so provider presets, authentication
policy, kernel declarations, and condition-specific ESM/CommonJS exports stay
aligned.
