---
"@hot-updater/server": minor
"hot-updater": patch
---

Move `createBundleDiff` from `@hot-updater/server/db` to its own entry, `@hot-updater/server/diff`. The `db` entry no longer loads bsdiff's WebAssembly, so a console that uses it builds for Cloudflare Workers.
