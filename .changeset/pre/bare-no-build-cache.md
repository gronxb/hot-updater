---
"@hot-updater/bare": patch
---

Always build the bundle. The bare build adapter no longer reads `HOT_UPDATER_BARE_BUILD_CACHE_DIR` and `HOT_UPDATER_BARE_BUILD_CACHE_KEY`, an undocumented build cache that only the repository's E2E tests used.
