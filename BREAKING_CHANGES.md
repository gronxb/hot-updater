# Breaking changes from `main` to `next`

This document records the net breaking changes on `next` relative to `main`.
The source comparison, before adding this document, uses merge base
`bf7c3ff5`, `main` at `a5272d70`, and `next` at `fbb9f77a`. The `main`-only
sponsor update is not part of the comparison.

The changes establish the Hot Updater v1 Release Catalog boundary. Additive
features are omitted unless they change an existing contract.

## Required migration shape

Hot Updater v1 is not an in-place infrastructure upgrade.

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
v0 resources before mutating them. Self-hosted SQL and MongoDB migrations also
create schema `1.0.0` only on empty storage and reject every v0 schema marker.

See the [v1 upgrade guide](<./docs/content/docs/(latest)/guides/upgrade-to-v1.mdx>)
for the parallel-cutover procedure.

## Bundle Signing validation and key tooling

Local PEM signing remains an explicit opt-in and derives its public identity
from the private key:

```ts
signing: {
  enabled: true,
  privateKeyPath: "./keys/private-key.pem",
}
```

`enabled: false` and omitting `signing` disable signing. Signing providers expose
only `getPublicKey()` and `sign()`; local, AWS KMS, Google Cloud KMS, and remote
signing configs do not accept `publicKeyPath`.

Expo projects configure the native trust anchor in `app.json` or
`app.config.ts` instead:

```json
["@hot-updater/expo", { "publicKeyPath": "./keys/public-key.pem" }]
```

Expo prebuild reads only this public file and never reads the local private key
or calls a KMS/remote signer. The file participates automatically in both
native fingerprints. Deploy and doctor compare the evaluated Expo trust anchor
with the signer's `getPublicKey()` result, including for CNG projects without
checked-in native directories.

Validation and key-management commands are stricter:

- Deploy signing requires RSA keys of at least 2048 bits and verifies every
  returned signature before upload. Public-key files must be SPKI PEM
  (`BEGIN PUBLIC KEY`). Weaker or unsupported keys must be replaced through a
  native key rollout.
- A missing, invalid, or mismatched native trust anchor fails deployment.
  Deploy cannot inspect already installed binaries.
- `keys generate` no longer overwrites either existing key file. For an
  intentional rotation, use a fresh `--output` directory and retain the old
  signer while installed apps still trust it.
- `keys export-public` defaults to cancelling a different or invalid embedded
  key replacement. `--yes` explicitly acknowledges that rotation. Use
  `--output <path>` to materialize an Expo trust-anchor file.

The optional `remoteSigning`, `awsKmsSigning`, and `googleCloudKmsSigning`
plugins from `hot-updater/signing` resolve their own public identity. Signing
remains independent of storage and database choice.
See the [Bundle Signing guide](<./docs/content/docs/(latest)/guides/bundle-signing.mdx>)
for public-key-only builds, SDK requirements, and key rotation.

Keeping the same signing key avoids a signing-key rotation, but does not remove
the requirement to release a v1 native SDK build with the v1 endpoint. If the
key changes, release the native app with the new public key before deploying
artifacts signed by it to that app population.

## Update protocol and HTTP routes

The per-installation v0 update decision is replaced by a shared Release Catalog
read followed by local selection on the device.

| `main`                                                                                  | `next`                                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId[/:cohort]`      | `GET /release-catalogs/app-version/:platform/:channelKey/:appVersion`                                      |
| `GET /fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId[/:cohort]` | `GET /release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash`                                 |
| Update response includes the selected Bundle artifact                                   | `GET /artifacts/:targetBundleId/from/:currentBundleId` resolves the artifact after local Release selection |
| `Hot-Updater-SDK-Version` request header participates in compatibility behavior         | The legacy SDK-version header contract is removed                                                          |
| `GET /api/bundles/channels` returns channel strings                                     | `GET`, `POST`, and `DELETE /hot-updater/admin/channels[/:id]` manage persistent Channel rows               |

Additional route and handler changes:

- Client routes are unversioned. Managed provider base URLs now point at the
  public deployment root; incompatible generations use different base URLs.
- `authorityId` is removed from CLI and server configuration. Catalog identity
  is allocated and persisted automatically, with no replacement setting.
- `HandlerOptions` is removed. The client handler always owns the v1
  update protocol and Insights ingestion. API key authentication is configured
  explicitly through the required `clientAccess` policy.
- The unified `createHandler` and `createHotUpdater().handler` surfaces are
  replaced by `createHandlers(...).client/admin` and
  `createHotUpdater().handlers.client/admin`. The client handler owns
  `/version`, Release Catalog, artifact, storage-download, and Insights-event
  routes. The admin handler owns Bundle, Release, Release Catalog row, Channel,
  database-commit, and Insights-query routes. Neither handler matches the
  other surface.
- Handlers match mount-relative paths, and `basePath` is removed. The framework
  owns the external mount path. Built-in storage paths are relative to the
  client handler and React Native resolves them against its configured
  `baseURL`.
- The admin handler has no built-in authentication callback. Protect its mount
  with framework middleware, register that middleware and the specific admin
  mount before the broader client mount, and fail startup when its credential
  is missing.
- `features`, including `features.bundles` and `features.updateCheck`, is
  removed. Explicitly mounting `handlers.admin` is the opt-in for admin routes,
  while mounting `handlers.client` exposes the complete client protocol.
  Insights ingestion is always available on the client handler and queries
  are always available on the admin handler, so the server-side Insights flag
  and `queryAccess` are removed. React Native reporting is enabled by default
  in both `HotUpdater.init` and `HotUpdater.wrap`; set `insights: false` to
  send no events. Client authentication moves to the
  required top-level `clientAccess` policy.
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
React Native app; the `api-key` client policy uses `x-api-key` by default or
the explicitly configured `headerName`. Local or direct-database Console
operation is unchanged. A Console configured with
`standaloneRepository` must use the admin root and keep its bearer header on
the server side; hosted Console user authentication remains a separate layer.

## Public Bundles and internal artifact ownership

The public CLI, Console, and React Native API continue to call a deployed
update a Bundle. Its public ID is the value printed by deploy, shown in the
Console, and returned by `HotUpdater.getBundleId()`.

The v1 plugin database splits that public Bundle from its immutable artifact.
Internally, a Release row owns delivery policy and references a `Bundle`
artifact row. The following fields therefore move from the plugin-core
`Bundle` artifact type to the internal Release row:

- `channel`
- `enabled`
- `fingerprintHash`
- `message`
- `rolloutCohortCount`
- `shouldForceUpdate`
- `targetAppVersion`
- `targetCohorts`

The combined `LegacyBundle` management shape is removed. Artifact writes accept
artifact fields only, while internal Release writes carry delivery policy. The
two internal IDs are independent UUIDv7 identities. In particular:

- Deploy creates an immutable artifact and a public Bundle ID.
- Promote creates a new public Bundle ID that reuses the existing artifact. It
  does not copy storage objects.
- Multiple public Bundles can reference one artifact.
- Rollout, targeting, enablement, force-update state, and messages update the
  public Bundle and recompile its Catalog.
- Rollback disables an exact public Bundle. The client then selects the
  previous compatible enabled Bundle or the built-in Bundle.
- An artifact cannot be deleted until all referencing public Bundles are
  disabled and hard-deleted.
- Binary patches are represented only by `Bundle.patches`. The deprecated
  `patchBaseBundleId`, `patchBaseFileHash`, `patchFileHash`, and
  `patchStorageUri` Bundle fields are removed.

## CLI changes

The public command group remains `bundle`, and every normal command accepts the
same public ID used by the Console and `HotUpdater.getBundleId()`.

| Removed or changed v0 usage                          | v1 behavior                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `bundle list --channel ... --target-app-version ...` | The command and filters remain; rows use the public Bundle ID.                        |
| `bundle show/update/enable/disable <bundle-id>`       | The commands remain and accept the public Bundle ID.                                  |
| `bundle promote <bundle-id>`                         | Use `bundle promote <source-id> --target <channel>`; the target gets a new public ID. |
| `bundle delete <bundle-ids...>`                      | Delete one disabled public Bundle at a time with `bundle delete <id>`.                |
| `patch --bundle-id ... --base-bundle-id ...`         | Prefer `--artifact-id` and `--base-artifact-id`; old names remain deprecated aliases. |
| `rollback <channel> [--target <bundle-id>]`          | Disable the exact public ID with `bundle disable <id>`.                               |
| Direct deletion of immutable bytes                   | Delete referencing public Bundles, then use Advanced `bundle artifact delete`.        |

The top-level `rollback` command is removed. Bundle mutations now support
revision preconditions and Catalog preflight. `bundle list --json` and
`bundle show --json` expose raw internal v1 rows and are not schema-compatible
with the v0 list wrapper or Bundle DTO. `db catalog preflight` and `db catalog
rebuild` verify or repair compiled projections.

Self-hosted deployments manage API keys through the same official database
domain used by managed init and Console:

```bash
hot-updater db migrate src/hotUpdater.ts
hot-updater api-key create src/hotUpdater.ts --name "Mobile app"
hot-updater api-key list src/hotUpdater.ts
hot-updater api-key revoke <api-key-id> src/hotUpdater.ts
```

`create` prints the plaintext API key exactly once. Only its SHA-256 hash and
non-secret metadata are persisted. The recommended self-hosted bootstrap sets
`clientAccess: { type: "api-key" }`, applies the schema, creates the API key,
and passes the printed value to `HotUpdater.init` in
`requestHeaders: { "x-api-key": apiKey }`. Use
`clientAccess: { type: "public" }` only as an explicit unauthenticated
alternative. Rotate a deployed credential by creating a replacement, shipping
clients with the replacement, and revoking the old API key after the rollout.

Managed AWS, Cloudflare, Firebase, and Supabase init create and register the
first API key automatically. A rerun reuses the existing
`HOT_UPDATER_API_KEY`, so managed users do not run the self-hosted
`hot-updater api-key create` command. Managed React Native setup passes that
value to `HotUpdater.init` through the `x-api-key` request header.

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
  database,
  clientAccess: { type: "api-key" },
  storage: [storagePlugin],
});
```

The returned object exposes in-process API key management through
`hotUpdater.apiKeys.create`, `hotUpdater.apiKeys.list`, and
`hotUpdater.apiKeys.revoke`. These operations use the configured direct
database plugin and are not HTTP routes on either handler.

The following v0 options are removed or renamed:

- `storages` and deprecated `storagePlugins` become `storage`.
- Insights ingestion and query routes are always available. React Native
  clients send automatic events by default from both `HotUpdater.init` and
  `HotUpdater.wrap`. Set `insights: false` to send no events.
- `features.clientAccessKeys: true` becomes
  `clientAccess: { type: "api-key" }`. API-key mode reads `x-api-key` by
  default. Set `headerName` to use another valid HTTP header; clients must send
  the same header and Release Catalog responses include it in `Vary`.
- `features.clientAccessKeys: false` becomes the explicit unauthenticated
  alternative, `clientAccess: { type: "public" }`.
- `clientAccess` is required. There is no implicit public or authenticated
  default. It applies to Release Catalog, artifact, and Insights ingestion
  routes; `/version`, signed storage downloads, and admin routes are
  unaffected.
- Update routes are always present on `handlers.client`.
- `basePath` is removed. The framework mount and React Native `baseURL` define
  the external client path without duplicating it in `createHotUpdater`.
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
    "plugins": [["@hot-updater/expo", { "channel": "production" }]]
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
    insights,
    apiKeys,
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
  Insights events, API keys, and Bundle patch relations.

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
- The mutable v0 per-Bundle asset layout and its cleanup fallback are removed.
  Fresh v1 deployments store manifest assets by content hash.
- Download URL policy belongs to the storage implementation. Server composition
  no longer wraps runtime-specific storage profiles.

See the [custom storage contract](<./docs/content/docs/(latest)/storage-plugins/custom-storage.mdx>)
for the complete operation requirements.

## React Native API changes

`HotUpdater.init` and `HotUpdater.wrap` now accept `baseURL` as their only
network source. The `resolver` and client-side `authorityId` options,
`HotUpdaterResolver`, its parameter/result helper types, and
`createDefaultResolver` are removed. Existing `baseURL` configuration remains
valid only when it points to a v1 client handler. Catalog client paths contain no
identity parameter. Catalog bookkeeping is internal and is not returned by the
public `HotUpdater.getActiveUpdateState()` API.

Custom GraphQL, RPC, and other transports must expose the v1 Release Catalog,
artifact, Insights-event, and `/version` HTTP protocol through an adapter or
proxy, then pass that endpoint as `baseURL`. There is no React Native callback
escape hatch for replacing only part of the protocol.

Do not configure `HotUpdater.init` and `HotUpdater.wrap` in the same app. Mixed
usage now reports a one-time `console.error`. Use `init + checkForUpdate` for a
custom or manual flow, or use `wrap` for the automatic HOC flow.

`NotifyAppReadyResult` changes shape:

- `{ status: "STABLE" }` becomes `{ status: "UNCHANGED" }`.
- An applied OTA can now return `{ status: "UPDATE_APPLIED", fromBundleId,
toBundleId, ... }`.
- Recovery returns directional `fromBundleId` and `toBundleId`, with optional
  internal selection IDs in `fromReleaseId` and `toReleaseId`, instead of
  `crashedBundleId`.
- `onNotifyAppReady` consumers and direct `HotUpdater.notifyAppReady()` callers
  must handle the new discriminated union.

App-ready transition and Bundle adoption reporting use the configured
`baseURL` and are enabled by default for both `HotUpdater.init` and
`HotUpdater.wrap`. Set `insights: false` to send nothing. The server routes
and backing model remain available regardless.

The deprecated positional `HotUpdater.updateBundle(bundleId, fileUrl)` overload
is removed. Pass the complete parameter object or call
`updateInfo.updateBundle()` on the result of `HotUpdater.checkForUpdate()`.

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
| `@hot-updater/js`                | `getUpdateInfo`                                                               | Release Catalog selection on the device and Release disable for rollback          |
| `@hot-updater/postgres`          | `getUpdateInfo`                                                               | Release Catalog compilation and exact Catalog reads                               |
| `@hot-updater/plugin-core`       | `createBlobDatabasePlugin` and profiled storage helpers                       | Fixed database models and flat storage plugins described above                    |
| `@hot-updater/plugin-core`       | `createRequestUpdateBundleResolver`, `getRequestUpdateBundleSeeds`            | `createRequestBundleResolver` for request-scoped Bundle reads                     |

`s3Storage` also stops creating S3 presigned download URLs implicitly. A server
runtime must configure `downloadUrlSigningKey` or provide a `getDownloadUrl`
implementation such as `cloudFrontDownloadUrl(...)`; CLI-only storage does not
need a download URL resolver.

## Compatibility intentionally retained

Persisted runtime compatibility is limited to state that can remain on a
device when a new v1 native build is installed over a v0 app:

- Native Bundle metadata containing Bundle-ID-only stable or staging state
- Local `BUNDLE_ID` files and retained on-device Bundle directories
- The persisted cohort identity used to keep existing installations in the
  same rollout bucket

This does not extend to server databases, storage objects, HTTP routes, custom
transport callbacks, or management write shapes. Those boundaries are fresh in
v1.

The detailed on-device retention rules are in the
[v1 compatibility inventory](./docs/release-catalog-v1-compatibility.md).

## Migration checklist

1. Preserve the v0 endpoint, credentials, resource IDs, and database backup.
2. Upgrade all Hot Updater packages together.
3. Scaffold fresh v1 infrastructure. For self-hosted providers, create schema
   `1.0.0` on an empty database; do not point v1 tooling at a v0 database.
4. Update custom database/storage providers, server options, removed imports,
   CLI automation, and app-ready result handling.
5. If signing is enabled, configure a local or provider signer and a separate
   native trust anchor. Check their public-key match and plan a native-first
   rollout if the signing key changes.
6. Redeploy the desired Releases because managed v0 policy is not backfilled.
7. Run `hot-updater doctor` and exercise Catalog fetch, artifact resolution,
   install, restart, and rollback.
8. Publish a new native build with the v1 endpoint. Keep v0 infrastructure
   running until its installed population no longer needs OTA service.
