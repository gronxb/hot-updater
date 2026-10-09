---
"@hot-updater/cli-tools": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/server": patch
"@hot-updater/standalone": patch
---

`hot-updater init` turns a config an earlier init wrote into one that loads: storage no longer passes the `commonOptions` helper init removes, `r2Storage` drops `cloudflareApiToken`, and the Supabase calls drop `supabaseAnonKey`.

`createHotUpdater` throws on `storages`, `storagePlugins`, `basePath`, and `cwd` with what replaces each, instead of ignoring them. A Release Catalog path with a channel name in place of its key, or a malformed fingerprint hash, answers `400` instead of `500`. `standaloneRepository` stops with a message when `baseUrl` points at the client mount instead of `handlers.admin`.
