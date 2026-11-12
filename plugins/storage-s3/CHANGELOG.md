# @hot-updater/storage-s3

## 1.2.0-rc.32

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.32

## 1.2.0-rc.31

### Patch Changes

- Updated dependencies [d4341b4]
  - @hot-updater/plugin-core@1.2.0-rc.31

## 1.2.0-rc.30

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.30

## 1.2.0-rc.29

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.29

## 1.2.0-rc.28

### Patch Changes

- Updated dependencies [43605fd]
- Updated dependencies [b03f1be]
  - @hot-updater/plugin-core@1.2.0-rc.28

## 1.2.0-rc.27

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.27

## 1.2.0-rc.26

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.26

## 1.2.0-rc.25

### Patch Changes

- Updated dependencies [0d8a448]
- Updated dependencies [211e584]
  - @hot-updater/plugin-core@1.2.0-rc.25

## 1.2.0-rc.24

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.24

## 1.2.0-rc.23

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.23

## 1.2.0-rc.22

### Patch Changes

- Updated dependencies [a823198]
  - @hot-updater/plugin-core@1.2.0-rc.22

## 1.2.0-rc.21

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.21

## 1.2.0-rc.20

### Patch Changes

- Updated dependencies [1e72e05]
  - @hot-updater/plugin-core@1.2.0-rc.20

## 1.2.0-rc.19

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.19

## 1.2.0-rc.18

### Patch Changes

- Updated dependencies [42f5b23]
  - @hot-updater/plugin-core@1.2.0-rc.18

## 1.2.0-rc.17

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.17

## 1.2.0-rc.16

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.16

## 1.2.0-rc.15

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.15

## 1.2.0-rc.14

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.14

## 1.2.0-rc.13

### Patch Changes

- Updated dependencies [b54eddc]
- Updated dependencies [1e85609]
- Updated dependencies [20006f2]
  - @hot-updater/plugin-core@1.2.0-rc.13

## 1.2.0-rc.12

### Patch Changes

- @hot-updater/plugin-core@1.2.0-rc.12

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

## 1.1.8

### Patch Changes

- @hot-updater/plugin-core@1.1.8

## 1.1.7

### Patch Changes

- @hot-updater/plugin-core@1.1.7

## 1.1.6

### Patch Changes

- @hot-updater/plugin-core@1.1.6

## 1.1.5

### Patch Changes

- ef2dc4f: Add `@hot-updater/storage-s3`, the S3 API storage adapter that `s3Storage`, `r2Storage`, and `neonStorage` now share. `hot-updater storage prune` now works on every official storage adapter: `r2Storage` (Node.js and Worker), `supabaseStorage`, and `firebaseStorage` gain `listObjects` and `deleteObjects`, and `standaloneStorage` sends them to the storage service's new `/list` and `/delete-objects` routes.
- @hot-updater/plugin-core@1.1.5
