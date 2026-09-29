---
"@hot-updater/console": patch
---

Check console access before a server function reads its input, so a signed-out request gets 401 instead of a validation error.
