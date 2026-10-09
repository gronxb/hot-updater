# Breaking changes from v0 to v1

This file lists every change a Hot Updater v0 (0.x) project must make to run on
v1. Each entry says what to search for in the project, then shows the v0 code
and its v1 replacement. Anything not listed here keeps its v0 name and
behavior. Entries that start with "Fails silently" produce no error when they
are missed.

The [v1 upgrade guide](https://hot-updater.dev/docs/guides/upgrade-to-v1)
covers the same migration as a step-by-step procedure.

## Before you start

v1 is a new infrastructure generation. A v0 app cannot update from a v1 server,
and a v1 app cannot update from a v0 server. Migrate in parallel:

- Keep the v0 endpoint, resources, database and credentials running until the
  installed v0 apps no longer need updates.
- Create new v1 infrastructure. Managed providers: run v1
  `hot-updater init` with new resource names
  ([Managed providers](#managed-providers)). Self-hosted servers: use a new,
  empty database ([Database and schema](#database-and-schema)). v1 refuses v0
  databases, and managed init refuses v0 functions, Workers, D1 databases and
  CloudFront distributions.
- Ship the v1 endpoint only in a new native build that contains the v1 SDK.
- Never deploy an OTA bundle built with v1 packages to a v0 app: the v1
  JavaScript requires the v1 native module. For OTA updates to v0 apps, keep a
  checkout pinned to the v0 packages with the v0 `.env.hotupdater`.
- Redeploy the bundles v1 should serve. v1 starts with an empty history and
  copies nothing from v0.

## Packages

Search for `"hot-updater"`, `"@hot-updater/` in every `package.json`.

- Install the same v1 version of `hot-updater` and every `@hot-updater/*`
  package. Mixed v0 and v1 packages fail to load.
- `@hot-updater/core` is renamed to `@hot-updater/protocol`. Replace the
  dependency and the imports. These exports have no v1 equivalent:
  `AppUpToDateInfo`, `AppUpdateAvailableInfo`, `AppUpdateInfo`,
  `AppUpdateStatus`, `AppVersionGetBundlesArgs`, `FingerprintGetBundlesArgs`,
  `GetBundlesArgs`, `SnakeCaseBundle`, `UpdateBundleParams` and `UpdateInfo`.
  `ChangedAsset` and `ChangedAssetFile` become `ArtifactAsset` and
  `ArtifactAssetFile`. For the result of an update check, use
  `Awaited<ReturnType<HotUpdaterInstance["checkForUpdate"]>>` with
  `HotUpdaterInstance` from `@hot-updater/react-native`.
- Expo apps keep `@hot-updater/expo` as a devDependency. It now also provides
  the config plugin ([Expo](#expo)).

## `hot-updater.config.ts`

### Remove `compressStrategy` and `releaseChannel`

Search for `compressStrategy`, `releaseChannel`.

```ts
// v0
export default defineConfig({
  // ...
  compressStrategy: "tar.br",
  releaseChannel: "production",
});
```

```ts
// v1
export default defineConfig({
  // ...
});
```

Neither option exists in v1, so TypeScript reports both; there is no
replacement. Updates always use per-file Brotli compression. `releaseChannel`
had no effect in v0; set the native default channel with
`npx hot-updater channel set <channel>`, or with the `channel` option of the
Expo config plugin.

### Remove `platform.android.stringResourcePaths`

Search for `stringResourcePaths`.

Delete it and move the values it pointed at into `AndroidManifest.xml`
([Android `strings.xml` values](#android-move-stringsxml-values-to-the-manifest)).

### Point `standaloneRepository` at the admin mount

Search for `standaloneRepository(`.

```ts
// v0
database: standaloneRepository({
  baseUrl: "https://example.com/hot-updater",
  commonHeaders: { Authorization: `Bearer ${adminToken}` },
  routes: {
    // ...
  },
}),
```

```ts
// v1
import { standaloneRepository } from "@hot-updater/standalone";
import { apiKeys, insights } from "hot-updater/plugins";

// ...
database: standaloneRepository({
  baseUrl: "https://example.com/hot-updater/admin",
  commonHeaders: { Authorization: `Bearer ${adminToken}` },
}),
plugins: [insights(), apiKeys()], // the plugins the server lists
```

- `baseUrl` is the exact path where the server mounts `handlers.admin`, not
  the client root ([Mount the handlers](#mount-handlersclient-and-handlersadmin)).
- `routes` is removed. The server must speak the v1 admin protocol, which
  `@hot-updater/server` does ([HTTP routes](#http-routes)).
- List the plugins the server runs, with the same options, in `plugins`.
  `hot-updater.config.ts` imports the factories from `hot-updater/plugins`;
  the server imports them from `@hot-updater/server/plugins`.
  `hot-updater api-key` and the Console's Insights and API key pages need
  this list.

With the v0 client-root `baseUrl`, the CLI stops before its first read and
asks for the path of `handlers.admin`.

### Update `standaloneStorage`

Search for `standaloneStorage(`.

```ts
// v0
storage: standaloneStorage({
  baseUrl: "https://storage.example.com/hot-updater",
}),
```

```ts
// v1
storage: standaloneStorage({
  baseUrl: "https://storage.example.com/hot-updater",
  protocol: "s3", // the scheme of the storage URIs your service returns
}),
```

- `protocol` is required. The `routes` keys are `put`, `get`, `exists` and
  `delete` (v0: `upload`, `delete`, `readText`, `getDownloadUrl`).
- The storage service must also implement `POST /get` and `POST /exists`.
  v1 no longer calls `/readText` or `/getDownloadUrl`. See
  [Standalone storage](https://hot-updater.dev/docs/storage-adapters/standalone).
- The adapter has no `getDownloadUrl`. The server's
  `createHotUpdater({ storage })` needs an adapter that can produce download
  URLs for the same objects.

## Managed providers

These entries apply to projects set up with `hot-updater init` for AWS,
Cloudflare, Firebase or Supabase.

### Give v1 init new resource names

Search for these keys in `.env.hotupdater` and in CI secrets.

v1 init reuses the names saved in `.env.hotupdater` or the environment, and
refuses a v0 function, Worker, D1 database or CloudFront distribution. Copy the
v0 values to the setup that keeps serving v0 apps, then change them before
running `npx hot-updater init`:

| Key                                                                                | Before v1 init                                                                                                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `HOT_UPDATER_AWS_LAMBDA_NAME`, `HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID`            | Remove. Init creates a new Lambda@Edge function (`hot-updater-v1-edge`) and distribution.                                           |
| `HOT_UPDATER_DYNAMODB_TABLE_NAME`                                                  | New. Init writes it (`hot-updater-v1`); `init --from-env-file` requires it.                                                         |
| `HOT_UPDATER_CLOUDFLARE_WORKER_NAME`                                               | Set a new name. The v1 default is still `hot-updater`.                                                                              |
| `HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID`, `HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME` | Point at a new D1 database.                                                                                                         |
| `HOT_UPDATER_SUPABASE_FUNCTION_NAME`                                               | Set `hot-updater-v1` (v0: `update-server`).                                                                                         |
| `HOT_UPDATER_SUPABASE_ANON_KEY`                                                    | Rename to `HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY`. v0 init stored the service-role key there; replace an anon key you set yourself. |

Firebase keys stay the same; v1 uses the fixed function name `hot-updater-v1`
and the Firestore collection `hot_updater_v1`. Storage buckets can be shared
with v0. Init also writes `HOT_UPDATER_API_KEY`, the client API key the app
must send.

### Match the v1 config shape

Search for `s3Database`, `cloudflareApiToken` inside `r2Storage(`,
`supabaseAnonKey`, and a provider config without `plugins`.

After v1 init, check that `hot-updater.config.ts` has the shape below. Init
adds a new option beside the old one it replaces, such as `credentials` beside
`cloudflareApiToken`, and TypeScript then reports the old one: delete it. Keep
the v0 credentials setup (`fromNodeProviderChain`, `fromIni`, `fromSSO` or
keys).

AWS:

```ts
// v0
import { s3Database, s3Storage } from "@hot-updater/aws";

const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromNodeProviderChain(),
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage(commonOptions),
  database: s3Database({
    ...commonOptions,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),
  updateStrategy: "appVersion",
});
```

```ts
// v1
import { dynamoDB, s3Storage } from "@hot-updater/aws";
import { apiKeys, insights, remoteConfig } from "hot-updater/plugins";

const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromNodeProviderChain(),
};

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: s3Storage({
    ...awsOptions,
    bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  }),
  database: dynamoDB({
    ...awsOptions,
    tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),
  plugins: [apiKeys(), insights(), remoteConfig()],
  updateStrategy: "appVersion",
});
```

The AWS identity that runs `deploy` also needs DynamoDB read and write access
to the new table.

Cloudflare, in older v0 configs that pass `cloudflareApiToken` to `r2Storage`:

```ts
// v0
storage: r2Storage({
  bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
  accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
  cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
}),
```

```ts
// v1
storage: r2Storage({
  bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
  accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
  },
}),
```

`d1Database` keeps its options; point `databaseId` at the new D1 database.

Supabase, in older v0 configs: replace
`supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!` with
`supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!` in
both `supabaseStorage` and `supabaseDatabase`.

All four providers: add `plugins: [apiKeys(), insights(), remoteConfig()]`,
importing the factories from `hot-updater/plugins`. These are the plugins
every managed v1 server runs. Without them, `hot-updater api-key`, `insights`
and `remote-config` exit with an error, and the Console hides Insights, Remote
Config and API keys.

### Point the app at the v1 URL and send the API key

Search for `/api/check-update`, `/functions/v1/update-server`, `baseURL`.

| Provider   | v0 `baseURL`                                                | v1 `baseURL`                                            |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| AWS        | `https://<v0 distribution>.cloudfront.net/api/check-update` | `https://<v1 distribution domain>`                      |
| Cloudflare | `https://<worker>.<subdomain>.workers.dev/api/check-update` | `https://<v1 worker>.<subdomain>.workers.dev`           |
| Firebase   | `<hot-updater function URL>/api/check-update`               | The `hot-updater-v1` function URL, without a suffix     |
| Supabase   | `https://<ref>.supabase.co/functions/v1/update-server`      | `https://<ref>.supabase.co/functions/v1/hot-updater-v1` |

Every managed v1 server requires the client API key from
`HOT_UPDATER_API_KEY` in the `x-api-key` header
([React Native app](#move-connection-options-to-hotupdaterinit)).
`.env.hotupdater` does not configure the app: pass the URL and the key to
native builds and OTA bundle builds through the build environment (CI or EAS
variables, `EXPO_PUBLIC_*`).

### Do not prune storage shared with v0

Search for `storage prune`, especially in scheduled CI jobs.

Fails silently: on a bucket that v0 also uses, v1 `hot-updater storage prune`
deletes v0 artifacts that installed v0 apps still download. Disable the job,
or keep it on the v0 packages, until v0 is retired, or give v1 its own bucket.

## React Native app

### Call methods on the instance `HotUpdater.init` returns

Search for `HotUpdater.` (every member except `init`), `HotUpdater.init(`,
`typeof HotUpdater.`.

`HotUpdater` has only `init`, and `init` returns the instance. Every other v0
`HotUpdater.<member>` exists on the instance under the same name.

```ts
// v0
import { HotUpdater } from "@hot-updater/react-native";

HotUpdater.init({ baseURL: "https://example.com/api/check-update" });

await HotUpdater.reload();
type UpdateInfo = Awaited<ReturnType<typeof HotUpdater.checkForUpdate>>;
```

```ts
// v1: src/hotUpdater.ts, imported wherever v0 used HotUpdater
import {
  HotUpdater,
  type HotUpdaterInstance,
} from "@hot-updater/react-native";

export const hotUpdater = HotUpdater.init({
  baseURL: "https://example.com/hot-updater",
});

await hotUpdater.reload();
type UpdateInfo = Awaited<ReturnType<HotUpdaterInstance["checkForUpdate"]>>;
```

Call `init` once, at the top level of a module, and export the instance. An
app that only used `HotUpdater.wrap` adds this call (next entry).

### Move connection options to `HotUpdater.init`

Search for `HotUpdater.wrap(`, `updateMode`, `HotUpdaterOptions`,
`ManualUpdateOptions`, `requestHeaders`.

```tsx
// v0: App.tsx
import { HotUpdater } from "@hot-updater/react-native";

export default HotUpdater.wrap({
  baseURL: "https://example.com/api/check-update",
  updateStrategy: "appVersion",
  requestHeaders: { Authorization: "Bearer <token>" },
  requestTimeout: 5000,
  onError: (error) => console.error(error),
  onNotifyAppReady: (result) => {},
  fallbackComponent: Splash,
  reloadOnForceUpdate: true,
  onProgress: (progress) => {},
  onUpdateProcessCompleted: (response) => {},
})(App);
```

```tsx
// v1: src/hotUpdater.ts
import { HotUpdater } from "@hot-updater/react-native";

export const hotUpdater = HotUpdater.init({
  baseURL: "https://example.com/hot-updater",
  requestHeaders: { "x-api-key": "<client API key>" },
  requestTimeout: 5000,
  onError: (error) => console.error(error),
  onNotifyAppReady: (result) => {},
});
```

```tsx
// v1: App.tsx
import { hotUpdater } from "./src/hotUpdater";

export default hotUpdater.wrap({
  updateStrategy: "appVersion",
  fallbackComponent: Splash,
  reloadOnForceUpdate: true,
  onProgress: (progress) => {},
  onUpdateProcessCompleted: (response) => {},
})(App);
```

- `wrap` accepts only `updateStrategy`, `fallbackComponent`, `onProgress`,
  `reloadOnForceUpdate` and `onUpdateProcessCompleted`. Move `baseURL`,
  `requestHeaders`, `requestTimeout`, `onError` and `onNotifyAppReady` to
  `init`.
- `baseURL` must be the v1 client root: the URL from v1 managed init
  ([table](#point-the-app-at-the-v1-url-and-send-the-api-key)) or the path
  where a self-hosted server mounts `handlers.client`. A v0 URL does not work.
- Send the client API key in `requestHeaders` when the server requires one:
  every managed server does, and so does a self-hosted server that lists
  `apiKeys()`. The header is `x-api-key` unless the server passes another
  `headerName` to `apiKeys()`.
- `updateMode` is removed. Replace
  `HotUpdater.wrap({ baseURL, updateMode: "manual" })(App)` with
  `HotUpdater.init({ baseURL })`, export `App` without `wrap`, and call
  `hotUpdater.checkForUpdate()` from your own flow. Delete
  `updateMode: "auto"`.
- `HotUpdaterOptions` becomes `HotUpdaterWrapOptions` (wrap options only).
  `ManualUpdateOptions` is removed. The init options type is
  `HotUpdaterInitOptions`.

### Remove `resolver`

Search for `resolver`, `createDefaultResolver`, `HotUpdaterResolver`,
`ResolverCheckUpdateParams`, `ResolverNotifyAppReadyParams`.

v1 has no client-side transport hook. A custom backend must serve the v1
client routes ([HTTP routes](#http-routes)) under one root, which the app
passes as `baseURL`. If `resolver.notifyAppReady` reported launches to a
server, use `onNotifyAppReady` in `init`, or add the Insights client plugin
and list `insights()` on the server:

```ts
import { HotUpdater, insights } from "@hot-updater/react-native";

export const hotUpdater = HotUpdater.init({
  baseURL: "https://example.com/hot-updater",
  plugins: [insights()],
});
```

### Handle the new `NotifyAppReadyResult`

Search for `onNotifyAppReady`, `"STABLE"`, `crashedBundleId`,
`NotifyAppReadyResult`.

```ts
// v0
onNotifyAppReady: (result) => {
  if (result.status === "STABLE") return;
  report(result.crashedBundleId);
},
```

```ts
// v1 (in HotUpdater.init)
onNotifyAppReady: (result) => {
  if (result.status === "UNCHANGED") return;
  if (result.status === "RECOVERED") report(result.fromBundleId);
},
```

`STABLE` is now `UNCHANGED`, and an applied update reports the new status
`UPDATE_APPLIED`. `RECOVERED` and `UPDATE_APPLIED` carry `fromBundleId` and
`toBundleId`, with optional `fromReleaseId` and `toReleaseId`.
`crashedBundleId` corresponds to `fromBundleId`.

### Apply updates with `updateBundle()` from the check result

Search for `.fileUrl`, `.fileHash`, `.manifestUrl`, `.manifestFileHash`,
`.changedAssets`, `updateBundle({`, and `updateBundle(` with two arguments.

```ts
// v0
const info = await HotUpdater.checkForUpdate({ updateStrategy: "appVersion" });
if (info) {
  await HotUpdater.updateBundle({
    bundleId: info.id,
    fileUrl: info.fileUrl,
    fileHash: info.fileHash,
    status: info.status,
  });
}
```

```ts
// v1
const info = await hotUpdater.checkForUpdate({ updateStrategy: "appVersion" });
if (info) {
  await info.updateBundle();
}
```

The check result no longer has `fileUrl`, `fileHash`, `manifestUrl`,
`manifestFileHash` or `changedAssets`. `hotUpdater.updateBundle()` takes a v1
artifact description that v0 code cannot build, so call
`info.updateBundle()`. The positional `updateBundle(bundleId, fileUrl)` form is
removed.

### Read download progress per file

Search for `downloadedBytes`, `totalBytes`, `"archive"`, `artifactType`.

`useHotUpdaterStore`, `hotUpdaterStore`, the `fallbackComponent` props and the
`onProgress` event no longer have `downloadedBytes` or `totalBytes`, and
`artifactType` is `"diff"` or `null`. Byte counts are per file in
`details.files`.

```tsx
// v0
const { downloadedBytes, totalBytes } = useHotUpdaterStore();

HotUpdater.addListener("onProgress", (event) => {
  if (event.artifactType === "archive") {
    show(event.downloadedBytes, event.totalBytes);
  }
});
```

```tsx
// v1
const { progress, details } = useHotUpdaterStore();

hotUpdater.addListener("onProgress", (event) => {
  for (const file of event.details.files) {
    show(file.downloadedBytes, file.totalBytes);
  }
});
```

### Report the manifest bundle ID to BugSnag

Search for `codeBundleId`.

```ts
// v0
Bugsnag.start({ codeBundleId: HotUpdater.getBundleId() });
```

```ts
// v1
Bugsnag.start({ codeBundleId: hotUpdater.getManifest().bundleId });
```

Fails silently: `hotUpdater.getBundleId()` returns the public bundle ID, which
changes on promote, while `withBugsnag` uploads source maps under the artifact
ID. Keeping the v0 call breaks symbolication.

## Expo

### Move the config plugin to `@hot-updater/expo`

Search for `"@hot-updater/react-native"` in `plugins` of `app.json` or
`app.config.(js|ts)`.

```json
{
  "expo": {
    "plugins": [["@hot-updater/react-native", { "channel": "production" }]]
  }
}
```

```json
{
  "expo": {
    "plugins": [["@hot-updater/expo", { "channel": "production" }]]
  }
}
```

Run `npx expo prebuild` before the next native build.

### Point the config plugin at the signing public key

Search for `signing` in `hot-updater.config.ts`, `HOT_UPDATER_PRIVATE_KEY` in
EAS variables and `eas.json`, `!/keys` in `.easignore`, `keys/` in
`.gitignore`.

v0 prebuild found the public key itself, from `HOT_UPDATER_PRIVATE_KEY`,
`signing.privateKeyPath` or a `public-key.pem` next to the private key. v1
prebuild embeds only the file named by `publicKeyPath`, and removes an
embedded key when the option is missing; deploy then fails.

```bash
npx hot-updater keys export-public --output ./keys/public-key.pem
```

```json
{
  "expo": {
    "plugins": [
      [
        "@hot-updater/expo",
        { "channel": "production", "publicKeyPath": "./keys/public-key.pem" }
      ]
    ]
  }
}
```

```gitignore
# v0
keys/

# v1: ship the public key, keep private keys out
keys/*
!keys/public-key.pem
```

- `keys export-public --output` refuses to overwrite a file. If v0
  `keys generate` already created `keys/public-key.pem`, point
  `publicKeyPath` at it.
- Commit the public key so EAS builds include it. Remove
  `HOT_UPDATER_PRIVATE_KEY` from the EAS environment and `!/keys` from
  `.easignore` if they only existed for prebuild. Keep the private key where
  `deploy` runs.

## Native projects

### Android: move `strings.xml` values to the manifest

Search for `hot_updater_channel`, `hot_updater_fingerprint_hash`,
`hot_updater_public_key` in `android/**/res/values*/strings.xml`.

Fails silently: v1 reads only `<meta-data>` in `AndroidManifest.xml`. Values
left in `strings.xml` are ignored, so the channel falls back to `production`
and signed bundles are rejected.

```xml
<!-- v0: android/app/src/main/res/values/strings.xml -->
<string name="hot_updater_channel" moduleConfig="true">production</string>
```

```xml
<!-- v1: android/app/src/main/AndroidManifest.xml, inside <application> -->
<meta-data android:name="com.hotupdater.CHANNEL" android:value="production" />
```

Run `npx hot-updater channel set <channel>`, `npx hot-updater fingerprint
create` (fingerprint strategy) and `npx hot-updater keys export-public --yes`
(signing) to write the meta-data, then delete the strings. Expo prebuild does
this itself.

### Android: set `newArchEnabled` on React Native before 0.82

Search for a `newArchEnabled=` line in `android/gradle.properties`.

Fails silently: v1 builds its Android library for the new architecture unless
`newArchEnabled=false`, while React Native before 0.82 treats a missing line as
the old architecture. Add `newArchEnabled=false` to an old-architecture app
that lacks the line.

## CLI and CI scripts

### Replace removed commands and flags

| v0                                                                 | v1                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hot-updater rollback <channel>`                                   | Removed. Disable the exact bundle with `hot-updater bundle disable <id>`.                                                                                             |
| `hot-updater bundle delete <id1> <id2>`                            | One ID per call, and the bundle must be disabled first: `bundle disable <id>`, then `bundle delete <id>`.                                                             |
| `hot-updater patch --bundle-id <id> --base-bundle-id <id>`         | `hot-updater patch --artifact-id <id> --base-artifact-id <id>`, with artifact IDs (`bundle_id` in `bundle show <id> --json`), not the IDs deploy prints.              |
| `hot-updater fingerprint` (fails when `fingerprint.json` is stale) | `hot-updater doctor`, which fails on a stale fingerprint. Bare `fingerprint` prints help and exits 1; `fingerprint create` is unchanged.                               |
| `hot-updater channel` (prints the native channels)                 | `hot-updater doctor --json`: `.details.native.ios.channel` and `.details.native.android.channel`. Bare `channel` prints help and exits 1; `channel set` is unchanged. |
| `hot-updater keys export-public --input <private key>`             | Configure `signing` in `hot-updater.config.ts`, then run `hot-updater keys export-public`. `--input` is removed.                                                       |
| `hot-updater build:android`                                        | `EXPERIMENTAL=1 hot-updater build:android`                                                                                                                            |
| `hot-updater doctor --server-base-url <v0 URL>`                    | Pass the v1 URL. Doctor fails a v0 server.                                                                                                                            |

A `rollback` that picked the newest enabled bundle becomes:

```bash
# v0
npx hot-updater rollback production -p ios -y
```

```bash
# v1
ID=$(npx hot-updater bundle list -c production -p ios --json --limit 1000 \
  | jq -r 'map(select(.enabled and .kind == "BUNDLE"))[0].id')
[ "$ID" != "null" ] && npx hot-updater bundle disable "$ID" -y
```

### Expect a new ID from `bundle promote`

Search for `bundle promote`.

Fails silently: `bundle promote` always creates a new ID (printed as
`ID: <id>`), enabled for all devices with no target cohorts. `--action move`
disables the source instead of keeping its ID. Scripts that reuse the source ID
after a move, or expect promote to copy a partial rollout, must re-apply the
rollout with `bundle update <new id>`.

### Update JSON consumers

Search for `--json` on `bundle list`, `bundle show` and `bundle update`.

`bundle list --json` prints an array of rows (no `{ data, pagination }`
wrapper), `bundle show --json` prints one row, and `bundle update --json`
prints `{ attempts, catalog, release }` with the row in `release`. Rows use
these fields:

| v0                                                    | v1                                                 |
| ----------------------------------------------------- | -------------------------------------------------- |
| `id`                                                  | `id`                                               |
| `channel`                                             | `channel_id`, an ID rather than the channel name   |
| `platform`, `enabled`, `message`                      | `platform`, `enabled`, `message`                   |
| `shouldForceUpdate`                                   | `should_force_update`                              |
| `targetAppVersion`                                    | `target_app_version`                               |
| `fingerprintHash`                                     | `fingerprint_hash`                                 |
| `rolloutCohortCount`                                  | `rollout_cohort_count`                             |
| `targetCohorts`                                       | `target_cohorts`, `[]` when unset                  |
| `fileHash`, `storageUri`, `gitCommitHash`, `metadata` | Not in the output. `bundle_id` is the artifact ID. |

### Parse the new deploy output

Search for scripts that read the output of `hot-updater deploy`, such as
`Deployment Successful`.

Fails silently: deploy prints `Deployment successful` followed by `ID: <id>`
(or `iOS ID: <id>` and `Android ID: <id>`), not
`Deployment Successful (<id>)`. The printed ID is the public bundle ID.

## Self-hosted server

These entries apply to code that calls `createHotUpdater` from
`@hot-updater/server`.

### Rewrite the `createHotUpdater` options

Search for `createHotUpdater(`, `storages:`, `storagePlugins:`, `basePath:`,
`routes:`, `cwd:`.

```ts
// v0
import { s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";

export const hotUpdater = createHotUpdater({
  database: kyselyAdapter({ db, provider: "postgresql" }),
  storages: [s3Storage({ region, credentials, bucketName })],
  basePath: "/hot-updater",
  routes: { updateCheck: true, bundles: true },
});
```

```ts
// v1
import { s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { apiKeys } from "@hot-updater/server/plugins";

export const hotUpdater = createHotUpdater({
  database: kyselyAdapter({ db, provider: "postgresql" }), // a new, empty database
  storage: s3Storage({ region, credentials, bucketName }),
  plugins: [apiKeys()], // or clientAccess: "public"
});
```

- `storages: [adapter]` and `storagePlugins` become `storage: adapter`: one
  adapter, the same one `hot-updater.config.ts` uploads with. `storage` is
  required: TypeScript reports a missing one, and startup throws without it.
- Choose a client-access policy, or startup throws. `clientAccess: "public"`
  keeps v0's open client routes. `plugins: [apiKeys()]` requires an API key
  from apps: create one with
  `npx hot-updater api-key create --name <name> src/hotUpdater.ts` and send
  it from `HotUpdater.init`. Use one or the other.
- `basePath`, `routes` and `cwd` are removed. The mounts in the next entry
  replace `basePath` and `routes`, and each plugin in `plugins` adds its own
  endpoints to them.
- Pass adapter objects, not `() => adapter` thunks.

### Mount `handlers.client` and `handlers.admin`

Search for `hotUpdater.handler`, `"/hot-updater/api`, `toNodeHandler`,
`@hot-updater/server/node`, `app.all(`.

`hotUpdater.handler` is split into `hotUpdater.handlers.client`, which serves
update checks and downloads (v0 `routes.updateCheck`), and
`hotUpdater.handlers.admin`, which serves bundle management (v0
`routes.bundles`). Put the admin handler behind authentication, register it
before the client handler, and mount it only if v0 had `routes.bundles: true`.

Fails silently: v0 protected `<basePath>/api/*`. The v1 admin routes live
where `handlers.admin` is mounted, so a guard left on `/hot-updater/api/*`
leaves the admin API open.

```ts
// v0 (Hono)
app.use("/hot-updater/api/*", bearerAuth({ token }));
app.mount("/hot-updater", hotUpdater.handler);
```

```ts
// v1 (Hono)
app.use("/hot-updater/admin/*", bearerAuth({ token }));
app.mount("/hot-updater/admin", hotUpdater.handlers.admin);
app.mount("/hot-updater", hotUpdater.handlers.client);
```

```ts
// v0 (Express)
import { toNodeHandler } from "@hot-updater/server/node";

app.use("/hot-updater/api", authMiddleware);
app.use("/hot-updater", toNodeHandler(hotUpdater));
```

```ts
// v1 (Express)
import { toNodeHandler } from "@hot-updater/server";

app.use(
  "/hot-updater/admin",
  authMiddleware,
  toNodeHandler(hotUpdater.handlers.admin),
);
app.use("/hot-updater", toNodeHandler(hotUpdater.handlers.client));
```

- Handlers match the path relative to their mount. Use a mount that strips
  its prefix (Hono and Elysia `mount`, Express `app.use`). A route that passes
  the full path, such as `app.all("/hot-updater/*", ...)`, now answers 404.
- Handlers take one `Request`. Remove a second context argument, such as
  `hotUpdater.handler(request, { env })`, and pass runtime bindings to the
  database and storage adapters when creating them.
- `toNodeHandler` comes from `@hot-updater/server` and takes one handler.
- The app's `baseURL` stays the client mount, such as
  `https://example.com/hot-updater`. `standaloneRepository` points at the
  admin mount ([`hot-updater.config.ts`](#point-standalonerepository-at-the-admin-mount)).
- Elysia: see
  [the Elysia recipe](https://hot-updater.dev/docs/custom/frameworks/elysia).

### Replace data methods with `hotUpdater.core`

Search for `.getBundleById(`, `.getBundles(`, `.insertBundle(`,
`.updateBundleById(`, `.deleteBundleById(`, `.getChannels(`,
`.getAppUpdateInfo(`, `.getUpdateInfo(` on the `createHotUpdater` result.

The public bundle ID that deploy prints and the Console shows is a Release ID
in `hotUpdater.core`:

| v0                                  | v1                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getBundleById(id)`                 | `core.getRelease(id)` for delivery fields, then `core.getBundle(release.bundle_id)` for the artifact                                                                                                     |
| `getBundles({ where, limit })`      | `core.listReleases({ limit, filter: { kind: "channelPlatform", channelId, platform } })`, with `channelId` from `core.findChannelByName(name)`; `core.listBundles({ limit, platform })` for artifacts |
| `insertBundle(bundle)`              | `core.deploy([{ bundle, release }])`, with the delivery fields in `release`                                                                                                                              |
| `updateBundleById(id, patch)`       | `core.updateReleasePolicy({ releaseId: id, patch })`                                                                                                                                                     |
| `deleteBundleById(id)`              | `core.deleteRelease({ releaseId: id })`, after disabling it                                                                                                                                              |
| `getChannels()`                     | `(await core.listChannels()).map((channel) => channel.name)`                                                                                                                                             |
| `getAppUpdateInfo`, `getUpdateInfo` | None. Devices select updates from the Release Catalog.                                                                                                                                                   |

### Database and schema

Search for `kyselyAdapter(`, `drizzleAdapter(`, `prismaAdapter(`,
`mongoAdapter(`, `db migrate`, `drizzle-kit push`, `prisma db push`, and the
database connection string.

- Point the server at a new, empty database and keep the v0 database for v0
  apps. v1 refuses a v0 database: `db migrate` exits with an error, and a v1
  server on a v0 database answers 503.
- Drizzle and Prisma: regenerate the schema, push it, then also run
  `db migrate`, which v0 did not need. Until it runs, every request answers
  503.

  ```bash
  npx hot-updater db generate src/hotUpdater.ts --yes
  npx drizzle-kit push # Prisma: npx prisma generate && npx prisma db push
  npx hot-updater db migrate src/hotUpdater.ts --yes
  ```

- Kysely and MongoDB: run `npx hot-updater db migrate src/hotUpdater.ts --yes`
  as in v0.
- MongoDB must run as a replica set or sharded cluster, because writes use
  transactions. Start `mongod --replSet rs0`, run `rs.initiate()` once, and add
  `replicaSet=rs0` to the connection string.

## HTTP routes

These entries apply to proxies, CDN and WAF rules, API gateways, and custom
servers or clients that speak the protocol.

Search for `app-version`, `fingerprint`, `check-update`, `/api/bundles`,
`Hot-Updater-SDK-Version`.

Client routes, relative to the `handlers.client` mount (v0: relative to
`basePath`):

| v0                                                                                      | v1                                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId[/:cohort]`      | `GET /release-catalogs/app-version/:platform/:channelKey/:appVersion`                   |
| `GET /fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId[/:cohort]` | `GET /release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash`              |
| The artifact URL inside the update response                                             | `GET /artifacts/v1/:targetBundleId/from/:currentBundleId`                               |
| `GET /version`                                                                          | `GET /version`                                                                          |

- `:channelKey` is the base64url encoding of the UTF-8 channel name.
- With `apiKeys()`, client routes require the `x-api-key` header and send
  `Vary: x-api-key`. A CDN must forward the header and include it in the cache
  key.
- The `Hot-Updater-SDK-Version` header is no longer sent or read.

Admin routes, relative to the `handlers.admin` mount (v0: under
`<basePath>/api/bundles`, with `routes.bundles: true`):

| v0                                          | v1                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/bundles` → `{ data, pagination }` | `GET /releases` for bundles and their delivery fields, `GET /bundles` for artifacts |
| `GET /api/bundles/:id`                      | `GET /releases/:id`, and `GET /bundles/:id` for the artifact                        |
| `POST /api/bundles`                         | `POST /releases` with `{ deployments: [{ bundle, release }] }`                      |
| `PATCH /api/bundles/:id`                    | `PATCH /releases/:id` with `{ patch, expectedRevision? }`                           |
| `DELETE /api/bundles/:id`                   | `DELETE /releases/:id?confirm=<id>`, after disabling it                             |
| `GET /api/bundles/channels`                 | `GET /channels`, which returns `{ id, name }` rows                                  |

A server that implemented the v0 `standaloneRepository` contract itself must
implement the v1 admin protocol, including `GET /version` with
`adminProtocol: 2`. See the
[Standalone Repository contract](https://hot-updater.dev/docs/database-adapters/standalone).

## Custom adapters

These entries apply to code built on `@hot-updater/plugin-core`.

### Database adapters

Search for `createDatabasePlugin`, `createBlobDatabasePlugin`,
`getBundleById`, `commitBundle`, `onUnmount`, `calculatePagination`.

```ts
// v0
export const myDatabase = createDatabasePlugin<MyConfig>({
  name: "myDatabase",
  factory: (config) => ({
    async getBundleById(id) {},
    async getUpdateInfo(args) {},
    async getBundles(options) {},
    async getChannels() {},
    async commitBundle({ changedSets }) {},
    async onUnmount() {},
  }),
});
```

```ts
// v1
import {
  createEngineDatabase,
  createSqlAdapter,
} from "@hot-updater/plugin-core";

export const myDatabase = (config: MyConfig) =>
  createEngineDatabase({
    name: "myDatabase",
    // myExecutor returns a SqlExecutor: { dialect, execute, transaction, batch? }
    adapter: createSqlAdapter({ executor: myExecutor(config) }),
  });
```

- The adapter stores rows and nothing else: a `SqlExecutor` for
  `createSqlAdapter`, a `KeyValueStore` for `createKvAdapter({ store })`, or a
  `DatabaseAdapter` (`id`, `get`, `query`, `write`, `fits`) directly. Core owns
  Bundles, Releases, Channels and update selection. Check an adapter with
  `verifyAdapter`.
- `onUnmount` becomes the adapter's `dispose`.
- `createBlobDatabasePlugin` has no equivalent, because object storage cannot
  make atomic conditional writes. Use `createKvAdapter({ store })` over a store
  that can.
- Pass `myDatabase({ ... })`, an object, to `database` in
  `hot-updater.config.ts` and `createHotUpdater`, not a thunk.

See [Custom database adapter](https://hot-updater.dev/docs/database-adapters/custom-database).

### Storage adapters

Search for `createUniversalStoragePlugin`, `createNodeStoragePlugin`,
`createRuntimeStoragePlugin`, `createStoragePlugin`, `supportedProtocol`.

```ts
// v0
export const myStorage = createUniversalStoragePlugin<MyConfig>({
  name: "myStorage",
  supportedProtocol: "my-storage",
  factory: (config) => ({
    node: {
      async upload(key, filePath) {},
      async exists(storageUri) {},
      async delete(storageUri) {},
      async downloadFile(storageUri, filePath) {},
    },
    runtime: {
      async getDownloadUrl(storageUri, context) {},
      async readText(storageUri, context) {},
    },
  }),
});
```

```ts
// v1
import {
  createStorageAdapter,
  createStorageUri,
} from "@hot-updater/plugin-core";

export const myStorage = (config: MyConfig) =>
  createStorageAdapter({
    name: "myStorage",
    protocol: "my-storage",
    async put({ key, body, contentType, contentLength }) {
      // upload body, a one-shot ReadableStream, under the complete key
      return {
        storageUri: createStorageUri({
          protocol: "my-storage",
          bucket: config.bucket,
          key,
        }),
      };
    },
    async get({ storageUri }) {
      return { response: null }; // a Response, or null when missing
    },
    async exists({ storageUri }) {
      return { exists: false };
    },
    async delete({ storageUri }) {
      return { deleted: true };
    },
    async getDownloadUrl({ storageUri }) {
      return { url: "" };
    },
  });
```

| v0                                            | v1                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `supportedProtocol`                           | `protocol`                                                                                |
| `node.upload(key, filePath)`                  | `put({ key, body, contentType, contentLength })`                                          |
| `node.exists(storageUri)` → `boolean`         | `exists({ storageUri })` → `{ exists }`                                                   |
| `node.delete(storageUri)`                     | `delete({ storageUri })` → `{ deleted: true }`                                            |
| `node.downloadFile`, `runtime.readText`       | `get({ storageUri })` → `{ response: Response \| null }`                                  |
| `runtime.getDownloadUrl(...)` → `{ fileUrl }` | `getDownloadUrl({ storageUri })` → `{ url }`                                              |
| `node.listObjects`, `node.deleteObjects`      | `listObjects`, `deleteObjects` at the top level                                           |
| A `context` parameter                         | None. Pass bindings and credentials when creating the adapter.                            |
| Storage URIs built with template literals     | `createStorageUri({ protocol, bucket, key })` and `parseStorageUri(storageUri, protocol)` |

`parseStorageUri` now rejects `?`, `#`, `.` and `..` segments, and keys that
are not canonically encoded. See
[Custom storage adapter](https://hot-updater.dev/docs/storage-adapters/custom-storage).

### The `Bundle` type

Search for `Bundle` and `BundlePatchArtifact` imported from
`@hot-updater/core` or `@hot-updater/plugin-core`, and reads of their fields.

- v1 `Bundle` describes the immutable artifact: `id`, `platform`,
  `gitCommitHash`, `metadata`, `manifestStorageUri`, `manifestFileHash`,
  `assetBaseStorageUri` and `patches`. The three manifest fields are required
  strings.
- `channel`, `enabled`, `fingerprintHash`, `message`, `rolloutCohortCount`,
  `shouldForceUpdate`, `targetAppVersion` and `targetCohorts` move to the
  Release that delivers the bundle.
- `fileHash` and `storageUri` are removed; there is no archive artifact.
- `patchBaseBundleId`, `patchBaseFileHash`, `patchFileHash` and
  `patchStorageUri` are removed. Use `patches`, or helpers such as
  `getPatchBaseBundleId(bundle)` from `@hot-updater/protocol`.
  `BundlePatchArtifact` requires `byteSize`.

## Removed exports

| Package                                                       | Removed                                                                                                                                                                                                                  | Use instead                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `@hot-updater/core`                                           | The package                                                                                                                                                                                                              | `@hot-updater/protocol` ([Packages](#packages))                                                                               |
| `@hot-updater/react-native`                                   | `createDefaultResolver`, `HotUpdaterResolver`, `ResolverCheckUpdateParams`, `ResolverNotifyAppReadyParams`                                                                                                               | `baseURL` with the v1 HTTP protocol                                                                                           |
| `@hot-updater/react-native`                                   | `HotUpdaterOptions`, `ManualUpdateOptions`                                                                                                                                                                               | `HotUpdaterWrapOptions`, `HotUpdaterInitOptions`                                                                              |
| `@hot-updater/server`                                         | The `./node` subpath                                                                                                                                                                                                     | `toNodeHandler` from `@hot-updater/server`                                                                                    |
| `@hot-updater/server`                                         | The `./db` subpath                                                                                                                                                                                                       | `hot-updater db generate` and `db migrate`; `HotUpdaterSchemaMigrationRequiredError` from `@hot-updater/plugin-core`          |
| `@hot-updater/server`                                         | `createHandler`, `HandlerOptions`, `HandlerRoutes`, `HandlerAPI`                                                                                                                                                         | `hotUpdater.handlers.client` and `hotUpdater.handlers.admin`                                                                  |
| `@hot-updater/server`                                         | `PaginationInfo`, `PaginationOptions`, `DataResponse`, `Paginated`, `PaginatedResult`, `ChannelsResponse`                                                                                                                | None                                                                                                                          |
| `@hot-updater/aws`                                            | `s3Database`, `S3DatabaseConfig`                                                                                                                                                                                         | `dynamoDB`, `DynamoDBConfig`: `tableName` is required; `bucketName` and `basePath` are removed                                |
| `@hot-updater/aws`                                            | `s3LambdaEdgeStorage`, `awsLambdaEdgeStorage`, `AwsLambdaEdgeStorageConfig`                                                                                                                                              | `s3Storage({ ..., getDownloadUrl: cloudFrontDownloadUrl({ keyPairId, publicBaseUrl, ssmRegion, ssmParameterName }) })`        |
| `@hot-updater/aws`                                            | `withCloudFrontSignedUrl`, `WithCloudFrontSignedUrlOptions`, `CloudFrontSignedUrlConfig`, `PublicBaseUrlResolver`                                                                                                        | `cloudFrontDownloadUrl`, `CloudFrontDownloadUrlOptions`; `publicBaseUrl` is a string                                          |
| `@hot-updater/cloudflare`                                     | `cloudflareApiToken` in `r2Storage`, `R2WranglerStorageConfig`                                                                                                                                                           | `r2Storage({ credentials: { accessKeyId, secretAccessKey } })`, `R2S3StorageConfig`                                           |
| `@hot-updater/cloudflare/worker`                              | `d1Database()` without arguments; `RequestEnvContext`, `CloudflareWorkerRuntimeEnv`, `CloudflareWorkerDatabaseEnv`, `CloudflareWorkerStorageEnv`                                                                         | `d1Database(env.DB)`, `D1Like`                                                                                                |
| `@hot-updater/cloudflare/worker`                              | `r2Storage({ publicBaseUrl, jwtSecret })` and the `JWT_SECRET` var                                                                                                                                                       | `r2Storage({ bucket: env.BUCKET, bucketName: env.BUCKET_NAME, downloadUrlSigningKey: env.STORAGE_DOWNLOAD_URL_SIGNING_KEY })` |
| `@hot-updater/cloudflare/worker`                              | `verifyJwtSignedUrl`                                                                                                                                                                                                     | The client handler's `/storage/...` route                                                                                     |
| `@hot-updater/supabase`, `@hot-updater/supabase/edge`         | `supabaseEdgeFunctionDatabase`, `supabaseEdgeFunctionStorage`, `SupabaseEdgeFunctionDatabaseConfig`, `SupabaseEdgeFunctionStorageConfig`                                                                                 | `supabaseDatabase`, `supabaseStorage` from `@hot-updater/supabase/edge`; `supabaseStorage` requires `bucketName`              |
| `@hot-updater/js`                                             | `getUpdateInfo`, `verifyJwtSignedUrl`, `withJwtSignedUrl`, `signToken`, `verifyJwtToken`                                                                                                                                 | None. Storage adapters sign download URLs.                                                                                    |
| `@hot-updater/postgres`                                       | `getUpdateInfo`, `appVersionStrategy`, `fingerprintStrategy`                                                                                                                                                             | None. `postgres(config)` returns the database.                                                                                |
| `@hot-updater/plugin-core`                                    | `createDatabasePlugin`, `DatabasePlugin`, `AbstractDatabasePlugin`, `CreateDatabasePluginOptions`                                                                                                                        | `createEngineDatabase`, `EngineDatabase`, `DatabaseAdapter`                                                                   |
| `@hot-updater/plugin-core`                                    | `createBlobDatabasePlugin`                                                                                                                                                                                               | `createKvAdapter` over a store with conditional writes                                                                        |
| `@hot-updater/plugin-core`                                    | `createNodeStoragePlugin`, `createRuntimeStoragePlugin`, `createUniversalStoragePlugin`, `createStoragePlugin`, `NodeStoragePlugin`, `RuntimeStoragePlugin`, `UniversalStoragePlugin`, `StoragePlugin`                   | `createStorageAdapter`, `StorageAdapter`                                                                                      |
| `@hot-updater/plugin-core`                                    | `HotUpdaterContext`, `StorageResolveContext`                                                                                                                                                                             | None                                                                                                                          |
| `@hot-updater/plugin-core`                                    | `decodeStorageObjectKey`                                                                                                                                                                                                 | `parseStorageUri(storageUri, protocol).key`, which is already decoded                                                         |
| `@hot-updater/plugin-core`                                    | `calculatePagination`, `paginateBundles`, `sortBundles`, `bundleMatchesQueryWhere`, `bundleIdMatchesFilter`, `resolveUpdateInfoFromBundles`, `DatabaseBundleQuery*`, `Paginated*`, `PaginationInfo`, `PaginationOptions` | None                                                                                                                          |
| `@hot-updater/plugin-core`                                    | `createRequestUpdateBundleResolver`, `getRequestUpdateBundleSeeds`                                                                                                                                                       | None                                                                                                                          |
| `@hot-updater/plugin-core`                                    | `BuildPlugin`, `BasePluginArgs`, `BuildPluginConfig`                                                                                                                                                                     | `BuildAdapter`, `BuildAdapterArgs`, `BuildAdapterConfig`                                                                      |
| `@hot-updater/bare`, `@hot-updater/expo`, `@hot-updater/rock` | `BarePluginConfig`, `ExpoPluginConfig`, `RockPluginConfig`                                                                                                                                                               | `BareAdapterConfig`, `ExpoAdapterConfig`, `RockAdapterConfig`                                                                 |

## Verify

1. Run `npx hot-updater doctor --server-base-url <v1 URL>`. It must report no
   errors, and `/version` must report `infrastructureGeneration: 1`.
2. Build a release native app with the v1 SDK, the v1 URL and the client API
   key. Deploy a test bundle to a test channel, restart the app to apply it,
   then run `bundle disable <id>` and confirm the app returns to the previous
   bundle.
