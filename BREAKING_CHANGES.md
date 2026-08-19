# Breaking changes from `main` to `next`

This document records the net breaking changes on `next` relative to `main`.
The source comparison, before adding this document, uses merge base
`bf7c3ff5`, `main` at `a5272d70`, and `next` at `fbb9f77a`. The `main`-only
sponsor update is not part of the comparison.

The changes establish the Hot Updater v1 Release Catalog boundary. Additive
features are omitted unless they change an existing contract.

## Required migration shape

Hot Updater v1 is not an in-place managed-infrastructure upgrade.

- Keep the existing v0 endpoint and resources available for installed v0
  binaries.
- Scaffold new v1 resources and use the new endpoint only from a new native
  build containing the v1 native SDK.
- Do not send v1 `@hot-updater/react-native` JavaScript to a v0 native binary by
  OTA. The v1 JavaScript requires native Release receipts, catalog high-water
  state, and selection guards.
- Upgrade all `hot-updater` and `@hot-updater/*` packages together.
- Redeploy the Releases that v1 should serve. Managed v1 infrastructure starts
  with an empty Release history and does not backfill v0 policy.

The supported combinations are:

| Native app | Infrastructure | Supported                                           |
| ---------- | -------------- | --------------------------------------------------- |
| v0         | Existing v0    | Yes; keep this endpoint unchanged                   |
| v0         | v1             | No; v1 does not expose the v0 update-check protocol |
| v1         | v0             | No; v1 requires Release Catalog and artifact routes |
| v1         | Fresh v1       | Yes                                                 |

Managed AWS, Cloudflare, Firebase, and Supabase initialization rejects selected
v0 resources before mutating them. Self-hosted SQL and MongoDB installations
have versioned migrations from supported v0 schema markers, but v0 writers must
stop before migrating and cannot write to schema `1.0.0`.

See the [v1 upgrade guide](<./docs/content/docs/(latest)/guides/upgrade-to-v1.mdx>)
for the parallel-cutover procedure.

## Update protocol and HTTP routes

The per-installation v0 update decision is replaced by a shared Release Catalog
read followed by local selection on the device.

| `main`                                                                                  | `next`                                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId[/:cohort]`      | `GET /release-catalogs/app-version/:authorityId/:platform/:channelKey/:appVersion`                         |
| `GET /fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId[/:cohort]` | `GET /release-catalogs/fingerprint/:authorityId/:platform/:channelKey/:fingerprintHash`                    |
| Update response includes the selected Bundle artifact                                   | `GET /artifacts/:targetBundleId/from/:currentBundleId` resolves the artifact after local Release selection |
| `Hot-Updater-SDK-Version` request header participates in compatibility behavior         | The legacy SDK-version header contract is removed                                                          |
| `GET /api/bundles/channels` returns channel strings                                     | `GET`, `POST`, and `DELETE /hot-updater/admin/channels[/:id]` manage persistent Channel rows               |

Additional route and handler changes:

- Client routes are unversioned. Managed provider base URLs now point at the
  public deployment root; incompatible generations use different base URLs.
- `authorityId` is part of Release Catalog identity. A non-default value must be
  stable and match across the CLI, server, and React Native client.
- `HandlerOptions.routes` is replaced by `HandlerOptions.features`.
- The unified `createHandler` and `createHotUpdater().handler` surfaces are
  replaced by `createHandlers(...).client/admin` and
  `createHotUpdater().handlers.client/admin`. The client handler owns
  `/version`, Release Catalog, artifact, storage-download, and Analytics-event
  routes. The admin handler owns Bundle, Release, Release Catalog row, Channel,
  database-commit, and Analytics-query routes. Neither handler matches the
  other surface.
- Handlers match mount-relative paths, and `HandlerOptions.basePath` is removed.
  The framework owns the external mount path. `createHotUpdater({
  clientBasePath })` declares where the client handler is mounted so generated
  storage URLs use that same path; its default is `/`.
- The admin handler has no built-in authentication callback. Protect its mount
  with framework middleware, register that middleware and the specific admin
  mount before the broader client mount, and fail startup when its credential
  is missing.
- `features.bundles` is removed. Explicitly mounting `handlers.admin` is the
  opt-in for admin routes. `features.analytics` is now boolean; Analytics
  ingestion is on the client handler and queries are on the admin handler, so
  `queryAccess` is removed.
- `standaloneRepository.baseUrl` now identifies the exact admin root, such as
  `https://example.com/hot-updater/admin`. Its default and fixed request paths
  are relative (`/bundles`, `/releases`, `/release-catalogs`, `/channels`, and
  `/database/commit`) rather than appending `/api` to a shared client root.
  `standaloneRepository({ routes })` no longer accepts a custom `channels`
  route.
- `toNodeHandler` now accepts one handler function, for example
  `toNodeHandler(hotUpdater.handlers.admin)`, rather than the whole Hot Updater
  object.
- Runtime bindings and credentials must be captured when constructing the
  database or storage plugin; handlers no longer accept a provider-specific
  request context as a second argument.
- `/version` reports the v1 infrastructure generation. Use `hot-updater doctor`
  against the generated public base URL before shipping the native build.

The recommended same-host composition is:

```ts
const adminToken = process.env.HOT_UPDATER_ADMIN_TOKEN;
if (!adminToken) throw new Error("HOT_UPDATER_ADMIN_TOKEN is required");

app.use("/hot-updater/admin/*", bearerAuth({ token: adminToken }));
app.mount("/hot-updater/admin", hotUpdater.handlers.admin);
app.mount("/hot-updater", hotUpdater.handlers.client);
```

`HotUpdater.init` and `HotUpdater.wrap` continue to use the client base URL
(`https://example.com/hot-updater`). Never embed the admin bearer token in the
React Native app; optional client authentication uses `x-api-key`. Local or
direct-database Console operation is unchanged. A Console configured with
`standaloneRepository` must use the admin root and keep its bearer header on
the server side; hosted Console user authentication remains a separate layer.

## Bundle and Release ownership

A Bundle is now an immutable artifact. A Release references a Bundle and owns
mutable delivery policy.

The following fields are removed from the public `Bundle` type and belong to a
Release instead:

- `channel`
- `enabled`
- `fingerprintHash`
- `message`
- `rolloutCohortCount`
- `shouldForceUpdate`
- `targetAppVersion`
- `targetCohorts`

`LegacyBundle` remains only as a transitional input for compatibility surfaces.
New integrations must not treat its policy fields as Bundle storage.
The retained `@hot-updater/js` `getUpdateInfo` helper now accepts
`LegacyBundle[]`, not the new immutable `Bundle[]`.

Release IDs and Bundle IDs are independent UUIDv7 identities. In particular:

- Deploy creates an immutable Bundle and a Release.
- Promote creates a new Release that reuses the existing Bundle bytes. It does
  not copy storage objects.
- Multiple Releases can reference one Bundle.
- Rollout, targeting, enablement, force-update state, and messages mutate the
  Release and recompile its Catalog.
- Rollback disables an exact Release. The client then selects the previous
  compatible enabled Release or the built-in Bundle.
- A Bundle cannot be deleted until all referencing Releases are disabled and
  hard-deleted.
- If both `Bundle.patches` and the deprecated scalar patch fields are present,
  the first `Bundle.patches` entry now wins. `main` preferred the scalar fields.

## CLI changes

Automation that manages delivery policy must use Release IDs.

| Removed or changed v0 usage                          | v1 replacement                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bundle list --channel ... --target-app-version ...` | `release list --channel ... --platform ...`; `bundle list` is artifact inventory         |
| `bundle show <bundle-id>` for rollout or enablement  | `release show <release-id>`; Bundle output contains artifact data and Release references |
| `bundle update <bundle-id>`                          | `release update <release-id>`                                                            |
| `bundle enable <bundle-id>`                          | `release enable <release-id>`                                                            |
| `bundle disable <bundle-id>`                         | `release disable <release-id>`                                                           |
| `bundle promote <bundle-id>`                         | `release promote <source-release-id> --target <channel>`                                 |
| `rollback <channel> [--target <bundle-id>]`          | `release disable <release-id>`                                                           |
| Direct deletion of a policy-owning Bundle            | Disable and delete all referencing Releases, then run `bundle delete`                    |

The top-level `rollback` command is removed. Release mutations now support
revision preconditions and Catalog preflight. `db catalog preflight` and
`db catalog rebuild` verify or repair compiled projections.

## Configuration and server composition

CLI configuration now receives direct plugin objects:

```ts
export default defineConfig({
  build: bare(),
  storage: storagePlugin,
  database: bundleRepository,
  updateStrategy: "appVersion",
});
```

The old `() => plugin` factory thunk is no longer the configuration contract.
Built-in provider call sites usually retain the source form
`storage: providerStorage(options)` because provider factories now return the
plugin object directly.

`createHotUpdater` changes from the v0 runtime-profile API to:

```ts
createHotUpdater({
  authorityId,
  database,
  storage: [storagePlugin],
  features: {
    updateCheck: true,
  },
  clientBasePath,
});
```

The following v0 options are removed or renamed:

- `storages` and deprecated `storagePlugins` become `storage`.
- `routes` becomes `features`.
- `basePath` becomes `clientBasePath` and defaults to `/`; set it to the exact
  external mount path when the client handler is mounted under a prefix.
- `cwd` is removed.
- Database and storage factory thunks are not accepted.
- Runtime request contexts are removed from database, storage, handler, and
  server API signatures.

## Expo config plugin package

The Expo config plugin moves from `@hot-updater/react-native` to
`@hot-updater/expo`. Expo projects must install `@hot-updater/expo` and update
the plugin entry before running Expo Prebuild or creating the next native
build:

```json
{
  "expo": {
    "plugins": [
      ["@hot-updater/expo", { "channel": "production" }]
    ]
  }
}
```

`@hot-updater/react-native` no longer publishes `app.plugin.js` or declares the
Expo config plugin's peer dependencies. Runtime imports remain in
`@hot-updater/react-native`; only the `app.json` or `app.config.js` plugin entry
moves.

## Database plugin contract and schema

The aggregate Bundle database API is replaced by a fixed official-domain
contract:

```ts
createDatabasePlugin({
  name,
  models: {
    bundles,
    bundlePatches,
    releases,
    releaseCatalogs,
    channels,
    analytics,
    clientAccessKeys,
  },
  commit,
  dispose,
});
```

This breaks custom database providers in the following ways:

- `createDatabasePlugin({ name, factory })` and its double-curried return value
  are removed.
- `getBundleById`, `getBundles`, `getChannels`, optional provider
  `getUpdateInfo`, `commitBundle`, and `onUnmount` are no longer the top-level
  provider shape.
- Generic CRUD/query DSLs, provider query languages, runtime contexts, and
  provider-owned update decisions are not public contracts.
- `commit({ changes, expectations })` is an ordered atomic boundary across the
  official models. Implementations must roll back all earlier changes on
  failure and enforce Release revision and Catalog generation expectations.
- Channels are persistent rows with opaque IDs and exact, case-sensitive names.
  `releases.channel_id` references that identity; Bundle rows no longer own a
  channel. Compatibility writes resolve the legacy `channel` value into the
  Release row.
- Schema `1.0.0` adds Releases, Release Catalogs, normalized Channels,
  Analytics events, client access keys, and Bundle patch relations.

`createBlobDatabasePlugin` is removed. Object storage cannot satisfy the atomic
Release/Catalog contract.

## Storage plugin contract

Profiled storage plugins are replaced by one runtime-independent object API:

```ts
createStoragePlugin({
  name,
  protocol,
  put,
  get,
  getDownloadUrl,
  exists,
  delete: deleteObject,
});
```

Breaking details for custom storage providers:

- `createNodeStoragePlugin`, `createRuntimeStoragePlugin`, and
  `createUniversalStoragePlugin` are removed.
- `supportedProtocol`, `profiles.node`, `profiles.runtime`, lifecycle hooks,
  runtime contexts, and local file paths are removed from the core boundary.
- Every single-object operation takes one object and returns one object. `put`
  consumes a one-shot Web `ReadableStream`; `get` returns
  `{ response: Response | null }`; `getDownloadUrl` returns `{ url }`; `exists`
  returns `{ exists }`; and single-object deletion returns `{ deleted: true }`.
- Optional storage-pruning capabilities still list objects and delete explicit
  keys; they do not restore the old Node/runtime profile split.
- Persisted locations use validated hierarchical
  `protocol://bucket/encoded/slash/key` URIs. Custom providers should use
  `createStorageUri` and `parseStorageUri` instead of concatenating strings.
- Download URL policy belongs to the storage implementation. Server composition
  no longer wraps runtime-specific storage profiles.

See the [custom storage contract](<./docs/content/docs/(latest)/storage-plugins/custom-storage.mdx>)
for the complete operation requirements.

## React Native API changes

The default resolver now fetches Release Catalogs and resolves artifacts from
the new routes. Existing `baseURL` configuration remains valid only when it
points to a v1 endpoint, and `authorityId` must match that endpoint when a
non-default identity is used.

`NotifyAppReadyResult` changes shape:

- `{ status: "STABLE" }` becomes `{ status: "UNCHANGED" }`.
- An applied OTA can now return `{ status: "UPDATE_APPLIED", fromBundleId,
toBundleId, ... }`.
- Recovery returns directional `fromBundleId` and `toBundleId`, with optional
  Release IDs, instead of `crashedBundleId`.
- `onNotifyAppReady` consumers and direct `HotUpdater.notifyAppReady()` callers
  must handle the new discriminated union.

For a custom resolver, `notifyAppReady` now receives a directional Analytics
event shape and returns `Promise<void>`. The legacy `checkUpdate` resolver hook
is intentionally retained, but it stays on legacy selection semantics and does
not provide Release Catalog guarantees. A v1 custom resolver implements both
`fetchReleaseCatalog` and `resolveArtifact`.

## Removed provider exports

| Package                          | Removed                                                                       | Replacement                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `@hot-updater/aws`               | `s3Database`                                                                  | `dynamoDB`; S3 remains artifact storage only                                      |
| `@hot-updater/aws`               | `s3LambdaEdgeStorage`                                                         | `s3Storage`                                                                       |
| `@hot-updater/aws`               | `withCloudFrontSignedUrl`                                                     | Pass `cloudFrontDownloadUrl(...)` as `s3Storage({ getDownloadUrl })`              |
| `@hot-updater/cloudflare/worker` | Context-derived `d1Database()` and runtime context types                      | Pass the native D1 binding to `d1Database(binding)`                               |
| `@hot-updater/cloudflare/worker` | Context-derived Worker storage                                                | Construct `r2Storage` with the native R2 binding                                  |
| `@hot-updater/cloudflare/worker` | `verifyJwtSignedUrl`                                                          | Use the server storage download handler                                           |
| `@hot-updater/supabase`          | Root `supabaseEdgeFunctionDatabase` and `supabaseEdgeFunctionStorage` exports | Import `supabaseDatabase` and `supabaseStorage` from `@hot-updater/supabase/edge` |
| `@hot-updater/js`                | `verifyJwtSignedUrl`, `withJwtSignedUrl`                                      | Use provider-owned download URL handling or the server storage handler            |
| `@hot-updater/postgres`          | `getUpdateInfo`                                                               | Release Catalog compilation and exact Catalog reads                               |
| `@hot-updater/plugin-core`       | `createBlobDatabasePlugin` and profiled storage helpers                       | Fixed database models and flat storage plugins described above                    |
| `@hot-updater/plugin-core`       | `createRequestUpdateBundleResolver`, `getRequestUpdateBundleSeeds`            | `createRequestBundleResolver` for request-scoped Bundle reads                     |

`s3Storage` also stops creating S3 presigned download URLs implicitly. A server
runtime must configure `downloadUrlSigningKey` or provide a `getDownloadUrl`
implementation such as `cloudFrontDownloadUrl(...)`; CLI-only storage does not
need a download URL resolver.

## Compatibility intentionally retained

The following are not breaking changes in this comparison, although some are
deprecated migration shims:

- Custom resolver `checkUpdate`
- `getMinBundleId` / `MIN_BUNDLE_ID`
- The old `updateBundle(id, url)` overload
- Manual `HotUpdater.wrap({ updateMode: "manual" })`
- `releaseChannel`, Android `stringResourcePaths`, database `sortBy`, Supabase
  `supabaseAnonKey`, and Cloudflare Wrangler R2 configuration
- Reads of retained v0 Bundle artifacts and supported self-hosted database
  migrations

The detailed retention rules are in the
[v1 compatibility inventory](./docs/release-catalog-v1-compatibility.md).

## Migration checklist

1. Preserve the v0 endpoint, credentials, resource IDs, and database backup.
2. Upgrade all Hot Updater packages together.
3. Scaffold fresh managed v1 infrastructure, or migrate a supported self-hosted
   database only after stopping v0 writers.
4. Update custom database/storage providers, server options, removed imports,
   CLI automation, and app-ready result handling.
5. Redeploy the desired Releases because managed v0 policy is not backfilled.
6. Run `hot-updater doctor` and exercise Catalog fetch, artifact resolution,
   install, restart, and rollback.
7. Publish a new native build with the v1 endpoint. Keep v0 infrastructure
   running until its installed population no longer needs OTA service.
