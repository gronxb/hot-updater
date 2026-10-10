---
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/react-native": minor
"@hot-updater/test-utils": minor
"@hot-updater/mock": patch
"hot-updater": patch
---

Storage adapters return the URL devices download from, and the server no longer serves downloads itself.

- `s3Storage` and `r2Storage` presign their download URLs again, as in v0: a URL signed with the adapter's credentials that expires in an hour, so devices download from the private bucket. `downloadUrlSigningKey` is removed from both. `s3Storage`'s `getDownloadUrl`, such as `cloudFrontDownloadUrl(...)`, still replaces the presigned URL.
- `r2Storage` from `@hot-updater/cloudflare/worker` takes `accountId` and `credentials`, R2's S3-compatible credentials, in place of `downloadUrlSigningKey`, and presigns the same URLs; without them it has no `getDownloadUrl`, as a Console needs. The managed Worker reads them from the `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets and the `ACCOUNT_ID` variable, which `hot-updater init` sets in place of `STORAGE_DOWNLOAD_URL_SIGNING_KEY`.
- The client handler's `GET /storage/:token/:signature` route is removed, with `createStorageDownloadUrl`, `createStorageDownloadPath`, and `parseStorageDownloadPath` from `@hot-updater/plugin-core`. `getDownloadUrl` returns an absolute `http(s)` URL, which the storage adapter test suite requires, and the React Native SDK takes only absolute artifact URLs.
