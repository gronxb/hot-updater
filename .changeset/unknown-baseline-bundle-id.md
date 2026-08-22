---
"@hot-updater/core": patch
"@hot-updater/js": patch
"@hot-updater/server": patch
---

Treat unknown build-time generated baseline bundle ids as the nil baseline during update checks so a fresh install still receives the latest compatible OTA instead of failing or rolling back.
