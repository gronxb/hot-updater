# @hot-updater/vercel

## 1.2.0-rc.1

### Patch Changes

- @hot-updater/cli-tools@1.2.0-rc.1
  - @hot-updater/protocol@1.2.0-rc.1
  - @hot-updater/server@1.2.0-rc.1
  - @hot-updater/plugin-core@1.2.0-rc.1
  - @hot-updater/postgres@1.2.0-rc.1

## 1.2.0-rc.0

### Minor Changes

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
  - @hot-updater/postgres@1.2.0-rc.0
  - @hot-updater/protocol@1.2.0-rc.0

## 1.1.3

### Patch Changes

- @hot-updater/cli-tools@1.1.3
  - @hot-updater/protocol@1.1.3
  - @hot-updater/server@1.1.3
  - @hot-updater/plugin-core@1.1.3
  - @hot-updater/postgres@1.1.3

## 1.1.2

### Patch Changes

- Updated dependencies [007e0c5]
  - @hot-updater/cli-tools@1.1.2
  - @hot-updater/protocol@1.1.2
  - @hot-updater/server@1.1.2
  - @hot-updater/plugin-core@1.1.2
  - @hot-updater/postgres@1.1.2

## 1.1.1

### Patch Changes

- @hot-updater/cli-tools@1.1.1
  - @hot-updater/protocol@1.1.1
  - @hot-updater/server@1.1.1
  - @hot-updater/plugin-core@1.1.1
  - @hot-updater/postgres@1.1.1

## 1.1.0

### Patch Changes

- Updated dependencies [7eaad78]
- Updated dependencies [60db3ea]
- Updated dependencies [99d0356]
  - @hot-updater/cli-tools@1.1.0
  - @hot-updater/plugin-core@1.1.0
  - @hot-updater/protocol@1.1.0
  - @hot-updater/server@1.1.0
  - @hot-updater/postgres@1.1.0

## 1.0.8

### Patch Changes

- @hot-updater/cli-tools@1.0.8
  - @hot-updater/protocol@1.0.8
  - @hot-updater/server@1.0.8
  - @hot-updater/plugin-core@1.0.8
  - @hot-updater/postgres@1.0.8

## 1.0.7

### Patch Changes

- @hot-updater/cli-tools@1.0.7
  - @hot-updater/protocol@1.0.7
  - @hot-updater/server@1.0.7
  - @hot-updater/plugin-core@1.0.7
  - @hot-updater/postgres@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies [5702bf5]
  - @hot-updater/plugin-core@1.0.6
  - @hot-updater/protocol@1.0.6
  - @hot-updater/server@1.0.6
  - @hot-updater/cli-tools@1.0.6
  - @hot-updater/postgres@1.0.6

## 1.0.5

### Patch Changes

- 73f2f64: `hot-updater init` for Vercel reuses and offers private Blob stores only.
- @hot-updater/cli-tools@1.0.5
  - @hot-updater/protocol@1.0.5
  - @hot-updater/server@1.0.5
  - @hot-updater/plugin-core@1.0.5
  - @hot-updater/postgres@1.0.5

## 1.0.4

### Patch Changes

- 33bdc32: Keep Vercel bundles in a private Blob store only. `vercelBlobStorage` no longer takes `access`: it works with a private store, and devices download through signed URLs that expire, issued only to requests with a valid API key. `hot-updater init` lists and creates private stores only. A project that init set up with a public store needs a private one: rerun `hot-updater init`, which warns about the saved public store and asks before replacing it, and select or create a private store (a non-interactive run uses `HOT_UPDATER_VERCEL_BLOB_STORE_NAME` once it names a private or new store). Bundles deployed to the public store stop downloading until you deploy them again. Remove `access` from `vercelBlobStorage` in `hot-updater.config.ts`; `HOT_UPDATER_VERCEL_BLOB_ACCESS` is no longer read.
- 33bdc32: `@hot-updater/vercel` re-exports `postgres`, so a managed Vercel project installs only `@hot-updater/vercel`. `hot-updater init` writes `import { postgres, vercelBlobStorage } from "@hot-updater/vercel"` and, on a rerun, moves an existing `postgres` import from `@hot-updater/postgres` there. You can then remove `@hot-updater/postgres` from the app's devDependencies.
- Updated dependencies [33bdc32]
  - @hot-updater/cli-tools@1.0.4
  - @hot-updater/protocol@1.0.4
  - @hot-updater/server@1.0.4
  - @hot-updater/plugin-core@1.0.4
  - @hot-updater/postgres@1.0.4

## 1.0.3

### Patch Changes

- Updated dependencies [407ec2c]
  - @hot-updater/cli-tools@1.0.3
  - @hot-updater/protocol@1.0.3
  - @hot-updater/server@1.0.3
  - @hot-updater/plugin-core@1.0.3
  - @hot-updater/postgres@1.0.3

## 1.0.2

### Patch Changes

- d4d1d07: Add Vercel as a managed provider. `hot-updater init` can now set up Hot Updater on Vercel: it selects the team, creates or reuses the project, selects or creates a Blob store (private by default) and connects it to the project, and takes a Postgres database connected to the project, a new Neon database from the Vercel Marketplace, or a connection URL. It then migrates the database, deploys the prebuilt Hot Updater Function to production, and issues the first API key. The new `@hot-updater/vercel` package exports `vercelBlobStorage`, and the generated config uses `postgres` from `@hot-updater/postgres`. `hot-updater agent infra` and `infra scaffold` take `--provider vercel`.
- Updated dependencies [ddfb139]
- Updated dependencies [d4d1d07]
  - @hot-updater/cli-tools@1.0.2
  - @hot-updater/protocol@1.0.2
  - @hot-updater/server@1.0.2
  - @hot-updater/plugin-core@1.0.2
  - @hot-updater/postgres@1.0.2
