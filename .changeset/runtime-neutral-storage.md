---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/cli-tools": minor
"hot-updater": minor
"@hot-updater/console": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/supabase": minor
"@hot-updater/standalone": minor
"@hot-updater/mock": minor
"@hot-updater/js": minor
---

Replace runtime-profiled storage plugins with the flat, runtime-independent
`createStoragePlugin({ name, protocol, put, get, getDownloadUrl, exists, delete
})` contract. Every operation uses an object input and object result. `put`
accepts a complete object key and bytes, `get` returns a Web `Response`,
`getDownloadUrl` returns the URL sent to update clients, and `delete` always
removes exactly one object. Remove file paths, factory thunks, runtime contexts,
prefix deletion, and lifecycle hooks from the core storage boundary.

Pass server storage implementations directly through
`createHotUpdater({ storage: [...] })`. URL policy belongs to each storage
implementation: AWS S3 can use its CloudFront resolver or a server-signed URL,
Firebase and Supabase generate provider URLs, and private Cloudflare R2 returns
a signed handler-relative URL. Remove `storageDelivery`, public base-URL and
top-level signing-key configuration, and the separate provider delivery
helpers. Cloudflare Worker storage uses the same `r2Storage` export name from
the `/worker` subpath and captures its native R2 binding at construction.

Update every built-in storage provider, CLI and Console consumer, managed
runtime, package entrypoint, and custom-hosting guide to the new contract.
Remove the storage-only JWT URL helpers and obsolete runtime-specific storage
creators. Route-group flags now live beside Analytics and client access keys in
the single `createHotUpdater({ features })` object.
