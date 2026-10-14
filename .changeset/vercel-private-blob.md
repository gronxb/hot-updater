---
"@hot-updater/vercel": patch
"hot-updater": patch
---

Keep Vercel bundles in a private Blob store only. `vercelBlobStorage` no longer takes `access`: it works with a private store, and devices download through signed URLs that expire, issued only to requests with a valid API key. `hot-updater init` lists and creates private stores only. A project that init set up with a public store needs a private one: rerun `hot-updater init`, which warns about the saved public store and asks before replacing it, and select or create a private store (a non-interactive run uses `HOT_UPDATER_VERCEL_BLOB_STORE_NAME` once it names a private or new store). Bundles deployed to the public store stop downloading until you deploy them again. Remove `access` from `vercelBlobStorage` in `hot-updater.config.ts`; `HOT_UPDATER_VERCEL_BLOB_ACCESS` is no longer read.
