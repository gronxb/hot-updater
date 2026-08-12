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
`createStoragePlugin({ name, protocol, put, get, exists, delete })` contract.
`put` accepts a complete object key and bytes, `get` returns a Web `Response`,
and `delete` always removes exactly one object. Remove file paths, factory
thunks, runtime contexts, prefix deletion, lifecycle hooks, and URL generation
from the core storage boundary.

Move public HTTP delivery to `createHotUpdater({ storageDelivery })`. The
server can expose signed streaming delivery routes for any custom storage URI,
while providers may supply separate CDN resolvers such as CloudFront, Firebase,
or Supabase delivery helpers. Cloudflare Worker storage now uses the same
`r2Storage` export name from the `/worker` subpath and streams R2 bindings
without requiring a provider URL API.

Update every built-in storage provider, CLI and Console consumer, managed
runtime, package entrypoint, and custom-hosting guide to the new contract.
Remove the storage-only JWT URL helpers and obsolete runtime-specific storage
creators.
