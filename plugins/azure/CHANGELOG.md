# @hot-updater/azure

## 1.2.0-rc.12

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.12
  - @hot-updater/protocol@1.2.0-rc.12
  - @hot-updater/server@1.2.0-rc.12
  - @hot-updater/plugin-core@1.2.0-rc.12

## 1.2.0-rc.11

### Patch Changes

- Updated dependencies [4c10736]
  - @hot-updater/cli-tools@1.2.0-rc.11
  - @hot-updater/protocol@1.2.0-rc.11
  - @hot-updater/server@1.2.0-rc.11
  - @hot-updater/plugin-core@1.2.0-rc.11

## 1.2.0-rc.10

### Patch Changes

- Updated dependencies [41444fa]
- Updated dependencies [fd2aa7e]
  - @hot-updater/cli-tools@1.2.0-rc.10
  - @hot-updater/protocol@1.2.0-rc.10
  - @hot-updater/server@1.2.0-rc.10
  - @hot-updater/plugin-core@1.2.0-rc.10

## 1.2.0-rc.9

### Patch Changes

- 12ff126: Catch a wrong upload-key password before it is stored, and keep secrets errors short.
  - `secrets put android-keystore` checks that the key password unlocks the key by signing an empty file with the JDK's `jarsigner`, as Gradle signs, before anything is stored. keytool's certificate request reads a PKCS12 key with the store password whatever the key password is, so a PKCS12 keystore stored with another key password, as EAS records it, used to fail the build only at its final signing step ("Given final block not properly padded"). The refusal reads `The key password doesn't unlock "<alias>".`, then `For PKCS12 keystores, the key password is the store password.` when the store password unlocks the key. At a terminal the CLI then offers to store the store password as the key password; in CI it stops, storing nothing.
  - `--key-alias`, which stored a keystore without checking it, now runs the same check, so it needs a JDK on the machine, as Android builds do.
  - `secrets issue android-keystore` names a stored keystore whose passwords don't open its key, and `--pem` still exports its certificate, and `hot-updater doctor` marks such a keystore in its Secrets block (`in the adapter, doesn't open`), with the reason and the command that stores it again. Without a JDK, doctor leaves it unchecked.
  - A `signing` secret the store doesn't hold points at importing the existing key, `npx hot-updater secrets put bundle-signing-key <key.pem>`, and at checking the name and access, never at `secrets issue`, whose new key every shipped app rejects. `secrets put android-keystore` without a file offers `secrets issue android-keystore` only for an app with no `.aab` on Play yet.
  - `infisical()`, `localSecrets()`, `secret()`, `secretsManager()`, `keyVault()`, and `secretManager()` errors print a line per idea, the reason first and the fix last, at most 76 columns: a provider's own message is wrapped or shortened on its own lines, a secret's full name gets a `Secret:` line, and long commands break with `\`.
  - `infisical()` names its instance's URL, as an `Instance:` line, only when `siteUrl`, `INFISICAL_DOMAIN`, or `INFISICAL_API_URL` sets it; with none set, messages say `Infisical`. A `siteUrl` that holds credentials is not quoted.

- Updated dependencies [12ff126]
  - @hot-updater/cli-tools@1.2.0-rc.9
  - @hot-updater/protocol@1.2.0-rc.9
  - @hot-updater/server@1.2.0-rc.9
  - @hot-updater/plugin-core@1.2.0-rc.9

## 1.2.0-rc.8

### Minor Changes

- 832d27c: `keyVault({ vaultName | vaultUrl, prefix?, credential? })` from `@hot-updater/azure` is a secrets adapter for Azure Key Vault, so an Azure team shares its build and deploy credentials the way `secretsManager()` and `secretManager()` do on AWS and Google Cloud. Each name is the secret `<prefix><name>` (`hot-updater-` by default); a name outside Key Vault's lower-case letters, digits, and single hyphens, such as `CLOUDFLARE_API_TOKEN`, becomes its lower-cased words and `--` with 10 hex digits of the name's SHA-256, since Key Vault matches names without regard to case. It signs in with `DefaultAzureCredential`, `azure/login` in CI and `az login` on your machine, or a `TokenCredential` you pass. `set` adds a version tagged `hot-updater-name`, refuses a value over Key Vault's 25,600 characters, and on a deleted secret still recoverable fails with the `az keyvault secret recover` and `purge` commands. A deleted secret reads as missing, and a missing role, a refused sign-in, or a disabled secret fail with what to do. `@azure/keyvault-secrets` and `@azure/identity` load on the first read or write, and every value and access token is masked in the CLI's output.
- c463534: `secret("<name>")` from `hot-updater` names every credential in `hot-updater.config.ts`. It replaces the `"secret:<name>"` strings and `secretEnv([...])` of earlier 1.2 RCs, so configs written for those RCs break: rerun `init` for a managed config, or edit it as below.

  ```ts
  import { defineConfig, secret } from "hot-updater";

  export default defineConfig({
    storage: r2Storage({
      bucketName: "bundles",
      accountId: "…",
      credentials: {
        accessKeyId: secret("HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID"),
        secretAccessKey: secret("HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
      },
    }),
    database: d1Database({
      databaseId: "…",
      accountId: "…",
      cloudflareApiToken: secret("HOT_UPDATER_CLOUDFLARE_API_TOKEN"),
    }),
    signing: { enabled: true, privateKey: secret("bundle-signing-key") },
    nativeBuild: {
      android: {
        release: { signing: { keystore: secret("release-keystore") } },
      },
      ios: { release: { signing: { ascApiKey: secret("asc-api-key") } } },
    },
  });
  ```

  - `secret()` returns a function an adapter calls on first use, so loading the config reads no secret. Called, it reads the environment or `.env.hotupdater` first, then the config's `secrets` adapter: one call reads every name of the config the environment doesn't set. With `localSecrets()`, an adapter credential must be set in the environment. Values are masked, and reserved names, such as `NODE_OPTIONS`, are refused.
  - `signing.privateKey`, `signing.keystore`, and `signing.ascApiKey` take only `secret()`: a string is a type error, and the CLI refuses it in one line.
  - Storage and database adapters take each credential as a string or a function (plugin-core's `Lazy<T>`), so servers keep passing their own environment's values. `s3Storage`, `dynamoDB`, and `r2Storage` also take access keys whose fields are lazy, and the header values of `standaloneRepository` and `standaloneStorage` may be lazy.
  - `init` writes `secret()` inline and moves an earlier RC config's `secretEnv` helpers to it. `doctor` and `secrets import` find the names in the adapters' `secret()`s.
  - `secrets put bundle-signing-key <key.pem>` moves an existing RSA key (PKCS#1 or PKCS#8, 2048 bits or more) into the secrets store as PKCS#8, reads it back, and prints its public key's SHA-256 fingerprint. A `privateKeyPath` key moves this way without a new trust anchor.

### Patch Changes

- Updated dependencies [8a440e3]
- Updated dependencies [2e3f250]
- Updated dependencies [21cfeec]
- Updated dependencies [c463534]
- Updated dependencies [5358377]
  - @hot-updater/cli-tools@1.2.0-rc.8
  - @hot-updater/plugin-core@1.2.0-rc.8
  - @hot-updater/server@1.2.0-rc.8
  - @hot-updater/protocol@1.2.0-rc.8

## 1.2.0-rc.7

### Patch Changes

- Updated dependencies [f3989de]
  - @hot-updater/cli-tools@1.2.0-rc.7
  - @hot-updater/protocol@1.2.0-rc.7
  - @hot-updater/server@1.2.0-rc.7
  - @hot-updater/plugin-core@1.2.0-rc.7

## 1.2.0-rc.6

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.6
  - @hot-updater/protocol@1.2.0-rc.6
  - @hot-updater/server@1.2.0-rc.6
  - @hot-updater/plugin-core@1.2.0-rc.6

## 1.2.0-rc.5

### Patch Changes

- 5d4d977: The config managed `init` writes names the provider's resources and reads its credentials with `secretEnv`, so a team store in `secrets` shares them: `init` stores them there with `HOT_UPDATER_API_KEY` and reads a missing one back, and `secrets import` moves an existing project's from `.env.hotupdater`. Doctor lists where each `secretEnv` name comes from. The storage and database adapters take a credential as a string or a function.
- Updated dependencies [dd7db4b]
- Updated dependencies [709997a]
- Updated dependencies [5d4d977]
- Updated dependencies [2fd1c83]
  - @hot-updater/cli-tools@1.2.0-rc.5
  - @hot-updater/plugin-core@1.2.0-rc.5
  - @hot-updater/server@1.2.0-rc.5
  - @hot-updater/protocol@1.2.0-rc.5

## 1.2.0-rc.4

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.4
  - @hot-updater/protocol@1.2.0-rc.4
  - @hot-updater/server@1.2.0-rc.4
  - @hot-updater/plugin-core@1.2.0-rc.4

## 1.2.0-rc.3

### Patch Changes

- Updated dependencies [3c00e7a]
  - @hot-updater/cli-tools@1.2.0-rc.3
  - @hot-updater/protocol@1.2.0-rc.3
  - @hot-updater/server@1.2.0-rc.3
  - @hot-updater/plugin-core@1.2.0-rc.3

## 1.2.0-rc.2

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.2
  - @hot-updater/protocol@1.2.0-rc.2
  - @hot-updater/server@1.2.0-rc.2
  - @hot-updater/plugin-core@1.2.0-rc.2

## 1.2.0-rc.1

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.1
  - @hot-updater/protocol@1.2.0-rc.1
  - @hot-updater/server@1.2.0-rc.1
  - @hot-updater/plugin-core@1.2.0-rc.1

## 1.2.0-rc.0

### Minor Changes

- 4d8e0d2: Every native build `hot-updater native-build ios|android` makes is tracked in Hot Updater's native build registry, with no flag to opt out.
  - Core's schema moves to 1.2.0 with the `native_builds` table, in the managed D1 and Supabase `0002_hot-updater_1.2.0.sql` migrations; `hot-updater init`, run again with its saved inputs, applies it. The table changes no existing one: its references to `channels` and `bundles` keep no counters.
  - Before it builds, and before any Apple or Google sign-in, the CLI checks read-only that it can track the build: it asks the registry for the build's scope (for its newest build when the build adapter's prebuild has yet to generate the native project), and reads back (`exists`) the artifact of a build the registry already tracks there; when the database or the storage can't be reached, it stops in seconds naming which, and builds nothing. A Debug build, which loads its JavaScript from Metro and has no built-in bundle, is not tracked: the CLI says so before it builds, and `--json` reports `registration: { skipped: "debug" }`. When tracking fails after the build, the CLI exits with the artifact's path and submits it to no store.
  - `--dry-run` builds but records and submits nothing, as `npm publish --dry-run` does: it runs the checks read-only, reads the store key `--submit` would use without signing in or issuing one, keeps the artifact on this machine, and prints what it would have recorded and where it would have submitted. A missing store key is reported, the build still runs, and the command exits 1 at the end. With `--json`, the last line has `dryRun: true`, `registration: { skipped: "dry-run" }`, and `submission: { skipped: "dry-run", destination }`.
  - Tracking takes the JavaScript bundle a release build compiled in out of the artifact (`assets/index.android.bundle` in an `.apk`, `base/assets/index.android.bundle` in an `.aab`, `main.jsbundle` in an `.ipa` or `.app`), uploads the artifact to `native-builds/<platform>/<id>/` in the config's storage (a simulator `.app` as one `.app.zip`), uploads that bundle as the build's built-in bundle, a bundle whose ID is the MIN_BUNDLE_ID and whose manifest lists only that file at an OTA bundle's asset path, then registers both. It uses the config's `database` and `storage`, as deploy does.
  - A tracked build records the build number its artifact reports, `build_number` (`CFBundleVersion` from the app's Info.plist, `versionCode` read with `aapt2`), which the Console shows; registrations without it, as from an earlier CLI, store null.
  - A tracked build records the store track it was submitted to: `native_builds` has nullable `submitted_to` (`testflight` or `play-internal`), `submitted_at_ms`, and `submitted_version`, the store's version and build number. Core's `recordNativeBuildSubmission(id, { destination, version })` writes them in one read and one write, refusing another platform's store, and answers null for an unknown build; the admin API serves it at `POST /native-builds/:id/submission`, and `standaloneRepository` maps it.
  - Core's API adds `registerNativeBuild`, which writes the build and its built-in bundle's row in one transaction, `findNativeBuild`, the newest build of a platform, channel, and fingerprint or exact app version in one indexed read, and `listNativeBuilds`. The admin API serves them at `POST /native-builds`, `GET /native-builds/latest`, and `GET /native-builds`, and `standaloneRepository` maps them; a server without these routes answers 404, which the CLI reports as a server to upgrade.
  - A built-in bundle is no OTA bundle: no release publishes it, the bundle totals leave it out, core refuses to delete it or to release it, and `storage prune` keeps its files and the artifact. Update checks and artifact responses do not change.
  - `azureBlobStorage` and `firebaseStorage` stream uploads instead of reading them into memory.
  - `@hot-updater/android-helper` and `@hot-updater/apple-helper` export `extractBuiltInBundle`, and `@hot-updater/apple-helper` exports `archiveAppBundle`.

- 5e7a045: The adapters a config creates check their credentials and create their clients on first use, so a config loads without them: `supabaseStorage`, `supabaseDatabase`, `azureBlobStorage`, `cosmosDatabase`, `vercelBlobStorage`, `firebaseStorage`, `standaloneRepository`, `awsKmsSigning`, `googleCloudKmsSigning`, and `remoteSigning`. A server runtime missing a credential now reports it at its first request instead of at startup. `makeEnv` takes `expectedContent` and rewrites only a file that still holds it. In `@hot-updater/cli-tools`, `parseLoadedEnv` and `readLoadedHotUpdaterEnv(cwd)` read an env file as `process.loadEnvFile` does, and `readHotUpdaterEnv` is removed: read `.env.hotupdater` with `readLoadedHotUpdaterEnv(cwd)`, as the config loads it, or `readHotUpdaterInitEnv(cwd).managedEnv`, as init reads it.

### Patch Changes

- 0050ff3: `hot-updater doctor --fix` is removed. Doctor only reports and writes nothing, and each issue names the command or edit that resolves it in `resolution` and `commands`. The flag is gone like any unknown option, and `--json` output has no `fixes` and no `fixability`. Run instead:

  | Issue                                                                                 | Run                                                                                                                                                                                 |
  | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `SCHEMA_MIGRATION_PENDING` on a deployment `hot-updater init` created                 | `npx hot-updater init --provider <provider> --from-env-file .env.hotupdater`, which migrates the database and redeploys the server back to back                                     |
  | `SCHEMA_MIGRATION_PENDING` on a server of your own                                    | `npx hot-updater db migrate <server file>` in the server's project, or `npx hot-updater db generate <server file>` and the database's tooling for Drizzle, Prisma, D1, and Supabase |
  | `MISSING_FINGERPRINT_JSON`, `FINGERPRINT_JSON_STALE`, `FINGERPRINT_ENGINE_UNRECORDED` | `npx hot-updater fingerprint create`                                                                                                                                                |
  | `FINGERPRINT_JSON_UNUSED`                                                             | Delete `fingerprint.json`, then rebuild the apps                                                                                                                                    |
  | `MISSING_PUBLIC_KEY`, `PUBLIC_KEY_MISMATCH`                                           | `npx hot-updater keys export-public`, then rebuild and release the app; installed apps keep the previous key                                                                        |
  | `RELEASE_CATALOG_STALE`                                                               | Any release change in the scope, such as `npx hot-updater deploy` or `npx hot-updater bundle update <id>`, which recompiles its catalog                                             |
  - Doctor detects a deployment `hot-updater init` created from the provider `.env.hotupdater` records, when the config's database is the one init saved: each provider's database factory now marks the resource it reaches, without credentials, and doctor compares it with the saved inputs. A database that reaches another resource gets your own server's commands; when doctor cannot tell, it names both, each with its condition. For it, a pending schema and an outdated server (`--server-base-url`) both name init with its saved inputs: it applies the release's migrations and then redeploys the Worker, Edge Function, Lambda@Edge function with its IAM role policy, Cloud Function, Vercel Function, or Function App, so the 503 window is the deploy. An outdated server of your own names `db migrate` and `db generate`, and doctor prints the reason beside the commands.
  - While the config lists a plugin of your own, doctor does not name init: init deploys only the official plugins and writes that list back into `hot-updater.config.ts`, so it would drop the plugin. Doctor says to remove it, or to migrate as a server of your own. While the schema is `SCHEMA_NEWER_THAN_CLI`, `SCHEMA_NOT_MIGRATABLE` or `PLUGIN_SCHEMA_CHANGED`, an outdated server's remediation names no command, since an upgrade would migrate over those settings.
  - `UNREFERENCED_ARTIFACTS` and `ARTIFACTS_UNCHECKED` are no longer reported: core deletes an artifact record with the last release that uses it, so it never leaves one behind.
  - A stale release catalog only follows an edit made outside Hot Updater or a partial restore, since every release change writes its scope's catalog; doctor still reports it, as devices read the catalog.
  - `@hot-updater/cloudflare/init` and `@hot-updater/supabase/init` no longer export `migrateDatabase`, and `@hot-updater/cli-tools` no longer exports `MigrateManagedDatabase`. `d1Database` and `supabaseDatabase` mark their target under the shared `Symbol.for("@hot-updater/database-target")` instead of their own symbols.
  - The schema fence's errors, the standalone repository's 503 error, and the Console's migration notice send you to `npx hot-updater doctor`, which names the command for the database.

- Updated dependencies [6276804]
- Updated dependencies [d7f02a6]
- Updated dependencies [8c675a2]
- Updated dependencies [28dfe97]
- Updated dependencies [e97d063]
- Updated dependencies [84b21f0]
- Updated dependencies [0050ff3]
- Updated dependencies [1ad0ebe]
- Updated dependencies [89cd5ce]
- Updated dependencies [f5cffc0]
- Updated dependencies [79c81f6]
- Updated dependencies [4d8e0d2]
- Updated dependencies [ed37acf]
- Updated dependencies [b78660b]
- Updated dependencies [4e4ddfb]
- Updated dependencies [f017e61]
- Updated dependencies [5e7a045]
  - @hot-updater/cli-tools@1.2.0-rc.0
  - @hot-updater/plugin-core@1.2.0-rc.0
  - @hot-updater/server@1.2.0-rc.0
  - @hot-updater/protocol@1.2.0-rc.0

## 1.1.5

### Patch Changes

- 25114fe: `azureBlobStorage` imports `node:stream` statically instead of on each read.
- @hot-updater/cli-tools@1.1.5
  - @hot-updater/protocol@1.1.5
  - @hot-updater/server@1.1.5
  - @hot-updater/plugin-core@1.1.5

## 1.1.4

### Patch Changes

- @hot-updater/cli-tools@1.1.4
  - @hot-updater/protocol@1.1.4
  - @hot-updater/server@1.1.4
  - @hot-updater/plugin-core@1.1.4

## 1.1.3

### Patch Changes

- @hot-updater/cli-tools@1.1.3
  - @hot-updater/protocol@1.1.3
  - @hot-updater/server@1.1.3
  - @hot-updater/plugin-core@1.1.3

## 1.1.2

### Patch Changes

- 007e0c5: Require Node.js 22.23.4+, 24.22.1+, or 26.12.1+, the releases that fix CVE-2026-111497 in Node's Brotli decoder. Node.js 20 is end of life and gets no fix.

  Patch creation (`hot-updater patch` and the patches `deploy` creates) first checks each manifest against the bundle's recorded `manifestFileHash`, verifying a signed one with the configured signing public key, then checks every Hermes bundle it downloads against the manifest's SHA-256 hashes, a Brotli-compressed one before decoding it. Storage bytes that deploy did not upload no longer reach the Brotli decoder or a patch.

- Updated dependencies [007e0c5]
  - @hot-updater/cli-tools@1.1.2
  - @hot-updater/protocol@1.1.2
  - @hot-updater/server@1.1.2
  - @hot-updater/plugin-core@1.1.2

## 1.1.1

### Patch Changes

- @hot-updater/cli-tools@1.1.1
  - @hot-updater/protocol@1.1.1
  - @hot-updater/server@1.1.1
  - @hot-updater/plugin-core@1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies [7eaad78]
- Updated dependencies [60db3ea]
- Updated dependencies [99d0356]
  - @hot-updater/cli-tools@1.1.0
  - @hot-updater/plugin-core@1.1.0
  - @hot-updater/protocol@1.1.0
  - @hot-updater/server@1.1.0

## 1.0.8

### Patch Changes

- @hot-updater/cli-tools@1.0.8
  - @hot-updater/protocol@1.0.8
  - @hot-updater/server@1.0.8
  - @hot-updater/plugin-core@1.0.8

## 1.0.7

### Patch Changes

- @hot-updater/cli-tools@1.0.7
  - @hot-updater/protocol@1.0.7
  - @hot-updater/server@1.0.7
  - @hot-updater/plugin-core@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies [5702bf5]
  - @hot-updater/plugin-core@1.0.6
  - @hot-updater/protocol@1.0.6
  - @hot-updater/server@1.0.6
  - @hot-updater/cli-tools@1.0.6

## 1.0.5

### Patch Changes

- @hot-updater/cli-tools@1.0.5
  - @hot-updater/protocol@1.0.5
  - @hot-updater/server@1.0.5
  - @hot-updater/plugin-core@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies [33bdc32]
  - @hot-updater/cli-tools@1.0.4
  - @hot-updater/protocol@1.0.4
  - @hot-updater/server@1.0.4
  - @hot-updater/plugin-core@1.0.4

## 1.0.3

### Patch Changes

- Updated dependencies [407ec2c]
  - @hot-updater/cli-tools@1.0.3
  - @hot-updater/protocol@1.0.3
  - @hot-updater/server@1.0.3
  - @hot-updater/plugin-core@1.0.3

## 1.0.2

### Patch Changes

- ddfb139: Add the Azure provider, `@hot-updater/azure`: `azureBlobStorage` keeps bundles in Azure Blob Storage and serves them through SAS URLs, and `cosmosDatabase` runs Hot Updater's database in one Azure Cosmos DB for NoSQL container, with `migrateCosmosDatabase` to create it and write the schema settings. `hot-updater init` sets up Azure with the Azure CLI: it creates a storage account, a serverless Cosmos DB account with strong consistency, and a Flex Consumption Function App, migrates the database, deploys the Hot Updater Function, and creates the client API key. `hot-updater agent infra setup` and `hot-updater infra scaffold` take `--provider azure`.
- Updated dependencies [ddfb139]
- Updated dependencies [d4d1d07]
  - @hot-updater/cli-tools@1.0.2
  - @hot-updater/protocol@1.0.2
  - @hot-updater/server@1.0.2
  - @hot-updater/plugin-core@1.0.2
