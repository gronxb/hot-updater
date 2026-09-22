---
"@hot-updater/plugin-core": patch
"@hot-updater/standalone": patch
"@hot-updater/console": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
---

Add indexed reverse patch lookup and its admin route. Standalone and Console load only requested patch relations; older or custom servers without the capability fail explicitly instead of scanning bundle history.
