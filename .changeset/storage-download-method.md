---
"hot-updater": patch
---

feat(storage): add `download()` method to StoragePlugin so `bundle promote --action copy` works on R2

Adds an optional `download(storageUri, destinationPath)` method to the `StoragePlugin` interface and uses it in `promoteBundle`'s copy path.

- Plugins that cannot mint a `fetch()`-able URL (notably `r2Storage`, which carries only a Cloudflare API token and so cannot generate S3 presigned URLs) now implement `download()` directly. Other plugins continue to work via a `getDownloadUrl` + `fetch` fallback.
- `r2Storage` implements `download()` via `wrangler r2 object get <bucket>/<key> --remote --file <dst>`, mirroring how `upload`/`delete` already shell out to wrangler. This unblocks `bundle promote --action copy` on Cloudflare R2 without requiring `s3Storage` from `@hot-updater/aws` (and without R2 S3-compatible credentials).
- `createStoragePlugin` gains an optional `supportsDownload: boolean` flag so the wrapper can expose the method while preserving the existing lazy factory-init contract.

Backward compatible: `download()` is optional on the interface, every existing plugin keeps working unchanged via the fallback. Only `r2Storage` declares `supportsDownload: true`.
