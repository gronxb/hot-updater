---
"@hot-updater/server": patch
"@hot-updater/cloudflare": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
---

`/version` answers with `cache-control: no-store`, and so does any client route whose response sets no `Cache-Control`, built in or from a plugin. Cloudflare's cache in front of the managed Worker keeps a `200` without `Cache-Control` for two hours, so after a Worker upgrade some edges kept answering the previous `/version`, and `hot-updater doctor` reported a server version that didn't match the scaffold although the new Worker was live. Release catalogs, artifacts, storage downloads, and admin routes keep the cache policy they already state.

A managed Cloudflare Worker deployed before this change may have left a `/version` answer in that cache during its own deploy. If `hot-updater doctor` reports the previous version after you upgrade, upload and deploy the same Worker build again: a new Worker version starts with an empty cache.
