# @hot-updater/storage-s3

## 1.1.5

### Patch Changes

- ef2dc4f: Add `@hot-updater/storage-s3`, the S3 API storage adapter that `s3Storage`, `r2Storage`, and `neonStorage` now share. `hot-updater storage prune` now works on every official storage adapter: `r2Storage` (Node.js and Worker), `supabaseStorage`, and `firebaseStorage` gain `listObjects` and `deleteObjects`, and `standaloneStorage` sends them to the storage service's new `/list` and `/delete-objects` routes.
- @hot-updater/plugin-core@1.1.5
