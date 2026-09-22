---
"@hot-updater/standalone": patch
"@hot-updater/server": patch
"@hot-updater/plugin-core": patch
---

Remove Standalone CRUD query emulation and translate domain reads directly to HTTP while retaining finite-ID filters, reverse patch lookup and custom routes. Support exact bundle offsets, exclusive with page and cursor pagination, so unaligned windows transfer only the requested bundle rows. Add the admin `GET /bundles/count` endpoint and configurable Standalone count route to count without loading bundles or patches. Servers without count support fail explicitly; aggregate bundle list pages still perform their existing count and patch hydration reads.
