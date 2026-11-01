# @hot-updater/vercel

## 1.1.6

### Patch Changes

- @hot-updater/server@1.1.6
  - @hot-updater/cli-tools@1.1.6
  - @hot-updater/postgres@1.1.6
  - @hot-updater/protocol@1.1.6
  - @hot-updater/plugin-core@1.1.6

## 1.1.5

### Patch Changes

- @hot-updater/cli-tools@1.1.5
  - @hot-updater/protocol@1.1.5
  - @hot-updater/server@1.1.5
  - @hot-updater/plugin-core@1.1.5
  - @hot-updater/postgres@1.1.5

## 1.1.4

### Patch Changes

- @hot-updater/cli-tools@1.1.4
  - @hot-updater/protocol@1.1.4
  - @hot-updater/server@1.1.4
  - @hot-updater/plugin-core@1.1.4
  - @hot-updater/postgres@1.1.4

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
