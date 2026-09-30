---
"@hot-updater/server": patch
"hot-updater": patch
---

Cache a scope's missing Release Catalog like a catalog. The `404` for a scope with no catalog yet, such as a store version before its first OTA release, now uses the catalog's `public, max-age=0, s-maxage=5` and is marked `x-hot-updater-catalog: none`, so a shared cache absorbs those update checks instead of passing each one to the origin. Other `404`s stay `private, no-store` and unmarked. `hot-updater doctor` and the agent server check accept the marked `404` as an empty catalog and still reject an unmarked one.
