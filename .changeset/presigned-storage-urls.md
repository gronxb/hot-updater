---
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
---

`s3Storage` and `r2Storage` presign their download URLs again, as in v0: a URL signed with the adapter's credentials that expires in an hour, so devices download from the private bucket. `downloadUrlSigningKey` is removed from both, and a self-hosted server needs no download URL secret. `s3Storage`'s `getDownloadUrl`, such as `cloudFrontDownloadUrl(...)`, still replaces the presigned URL.
