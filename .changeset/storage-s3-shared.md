---
"@hot-updater/storage-s3": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/neon": patch
"@hot-updater/supabase": patch
"@hot-updater/firebase": patch
"@hot-updater/standalone": patch
---

Add `@hot-updater/storage-s3`, the S3 API storage adapter that `s3Storage`, `r2Storage`, and `neonStorage` now share. `hot-updater storage prune` now works on every official storage adapter: `r2Storage` (Node.js and Worker), `supabaseStorage`, and `firebaseStorage` gain `listObjects` and `deleteObjects`, and `standaloneStorage` sends them to the storage service's new `/list` and `/delete-objects` routes.
