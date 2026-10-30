# @hot-updater/storage-s3

## 1.2.0-rc.11

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.11

## 1.2.0-rc.10

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.10

## 1.2.0-rc.9

### Patch Changes

- 1.2.0-rc.9 includes 1.1.4 and 1.1.5: `neonStorage` from `@hot-updater/neon` stores bundles in Neon Object Storage, and the package re-exports `postgres`; `s3Storage`, `r2Storage`, and `neonStorage` share `@hot-updater/storage-s3`, and `hot-updater storage prune` works on every official storage adapter; `azureBlobStorage` imports `node:stream` statically. Their credentials accept `secret("<name>")` like the other adapters: the access keys of `neonStorage`, `s3Storage`, and `r2Storage` may be lazy, read once on the first request, and `postgres` takes a lazy `connectionString`.

  ```ts
  import { neonStorage, postgres } from "@hot-updater/neon";
  import { defineConfig, secret } from "hot-updater";

  export default defineConfig({
    storage: neonStorage({
      endpoint: "https://br-xxx.storage.c-5.us-east-2.aws.neon.tech",
      bucketName: "hot-updater-bundles",
      credentials: {
        accessKeyId: secret("AWS_ACCESS_KEY_ID"),
        secretAccessKey: secret("AWS_SECRET_ACCESS_KEY"),
      },
    }),
    database: postgres({ connectionString: secret("DATABASE_URL") }),
  });
  ```

- @hot-updater/plugin-core@1.2.0-rc.9

## 1.1.5

### Patch Changes

- ef2dc4f: Add `@hot-updater/storage-s3`, the S3 API storage adapter that `s3Storage`, `r2Storage`, and `neonStorage` now share. `hot-updater storage prune` now works on every official storage adapter: `r2Storage` (Node.js and Worker), `supabaseStorage`, and `firebaseStorage` gain `listObjects` and `deleteObjects`, and `standaloneStorage` sends them to the storage service's new `/list` and `/delete-objects` routes.
- @hot-updater/plugin-core@1.1.5
