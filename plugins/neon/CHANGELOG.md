# @hot-updater/neon

## 1.1.5

### Patch Changes

- e9f1c1f: Add `@hot-updater/neon`: `neonStorage` stores bundles in a Neon Object Storage bucket through its S3 API, with path-style requests and presigned download URLs, and the package re-exports `postgres` so a Neon project's config imports storage and database from one package.
- ef2dc4f: Add `@hot-updater/storage-s3`, the S3 API storage adapter that `s3Storage`, `r2Storage`, and `neonStorage` now share. `hot-updater storage prune` now works on every official storage adapter: `r2Storage` (Node.js and Worker), `supabaseStorage`, and `firebaseStorage` gain `listObjects` and `deleteObjects`, and `standaloneStorage` sends them to the storage service's new `/list` and `/delete-objects` routes.
- Updated dependencies [ef2dc4f]
  - @hot-updater/storage-s3@1.1.5
  - @hot-updater/plugin-core@1.1.5
  - @hot-updater/postgres@1.1.5
