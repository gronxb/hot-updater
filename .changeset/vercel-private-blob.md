---
"@hot-updater/vercel": patch
"hot-updater": patch
---

Keep Vercel bundles in a private Blob store only. `vercelBlobStorage` no longer takes `access`: it works with a private store, and devices download through signed URLs that expire, issued only to requests with a valid API key. `hot-updater init` lists and creates private stores only. A project that init set up with a public store needs a private one: rerun `hot-updater init`, which warns about the saved public store, and select or create a private store (a non-interactive run stops until `HOT_UPDATER_VERCEL_BLOB_STORE_ID` is removed and `HOT_UPDATER_VERCEL_BLOB_STORE_NAME` names a private or new store). Then deploy the bundles again. Remove `access` from `vercelBlobStorage` in `hot-updater.config.ts`; `HOT_UPDATER_VERCEL_BLOB_ACCESS` is no longer read.
