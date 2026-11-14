# @hot-updater/neon

## 1.1.14

### Patch Changes

- Updated dependencies [a250d09]
- Updated dependencies [d58dcfa]
  - @hot-updater/plugin-core@1.1.14
  - @hot-updater/postgres@1.1.14
  - @hot-updater/storage-s3@1.1.14

## 1.1.13

### Patch Changes

- @hot-updater/plugin-core@1.1.13
  - @hot-updater/postgres@1.1.13
  - @hot-updater/storage-s3@1.1.13

## 1.1.12

### Patch Changes

- @hot-updater/plugin-core@1.1.12
  - @hot-updater/postgres@1.1.12
  - @hot-updater/storage-s3@1.1.12

## 1.1.11

### Patch Changes

- @hot-updater/postgres@1.1.11
  - @hot-updater/storage-s3@1.1.11
  - @hot-updater/plugin-core@1.1.11

## 1.1.10

### Patch Changes

- @hot-updater/plugin-core@1.1.10
  - @hot-updater/postgres@1.1.10
  - @hot-updater/storage-s3@1.1.10

## 1.1.9

### Patch Changes

- @hot-updater/plugin-core@1.1.9
  - @hot-updater/postgres@1.1.9
  - @hot-updater/storage-s3@1.1.9

## 1.1.8

### Patch Changes

- @hot-updater/plugin-core@1.1.8
  - @hot-updater/postgres@1.1.8
  - @hot-updater/storage-s3@1.1.8

## 1.1.7

### Patch Changes

- @hot-updater/plugin-core@1.1.7
  - @hot-updater/postgres@1.1.7
  - @hot-updater/storage-s3@1.1.7

## 1.1.6

### Patch Changes

- @hot-updater/plugin-core@1.1.6
  - @hot-updater/postgres@1.1.6
  - @hot-updater/storage-s3@1.1.6

## 1.1.5

### Patch Changes

- e9f1c1f: Add `@hot-updater/neon`: `neonStorage` stores bundles in a Neon Object Storage bucket through its S3 API, with path-style requests and presigned download URLs, and the package re-exports `postgres` so a Neon project's config imports storage and database from one package.
- ef2dc4f: Add `@hot-updater/storage-s3`, the S3 API storage adapter that `s3Storage`, `r2Storage`, and `neonStorage` now share. `hot-updater storage prune` now works on every official storage adapter: `r2Storage` (Node.js and Worker), `supabaseStorage`, and `firebaseStorage` gain `listObjects` and `deleteObjects`, and `standaloneStorage` sends them to the storage service's new `/list` and `/delete-objects` routes.
- Updated dependencies [ef2dc4f]
  - @hot-updater/storage-s3@1.1.5
  - @hot-updater/plugin-core@1.1.5
  - @hot-updater/postgres@1.1.5
