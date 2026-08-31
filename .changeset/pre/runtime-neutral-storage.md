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
accepts a complete object key and a one-shot Web stream, `get` returns a Web
`Response`,
`getDownloadUrl` returns the URL sent to update clients, and `delete` always
targets exactly one object and resolves to the idempotent `{ deleted: true }`
postcondition. Remove file paths, factory thunks, runtime contexts, prefix
deletion, and lifecycle hooks from the core storage boundary.

Standardize persisted locations as hierarchical
`protocol://bucket/encoded/slash/key` URIs. `createStorageUri` encodes each key
segment without flattening slash hierarchy, while `parseStorageUri` performs
the matching validation and decoding. Empty and dot segments, query strings,
and fragments are rejected.

Pass server storage implementations directly through
`createHotUpdater({ storage: [...] })`. URL policy belongs to each storage
implementation: AWS S3 can use its CloudFront resolver or a server-signed URL,
Firebase and Supabase generate provider URLs, and private Cloudflare R2 returns
a signed handler-relative URL. Remove `storageDelivery`, public base-URL and
top-level signing-key configuration, and the separate provider delivery
helpers. Cloudflare Worker storage uses the same `r2Storage` export name from
the `/worker` subpath and captures its native R2 binding at construction.

Resolve persisted URIs by registered scheme ownership first, including `http`
and `https`. Only an HTTP(S) URI without an owner uses direct fetch or redirect;
other unowned schemes are unsupported. Runtime composition accepts at most one
storage plugin for each scheme.

Update every built-in storage provider, CLI and Console consumer, managed
runtime, package entrypoint, and custom-hosting guide to the new contract.
Remove the storage-only JWT URL helpers and obsolete runtime-specific storage
creators. Route-group flags are removed; Analytics is always available and the
required `clientAccess` policy controls client authentication.
