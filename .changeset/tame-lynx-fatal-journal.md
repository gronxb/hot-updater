---
"@hot-updater/lynx": patch
---

Revoke a Lynx runtime generation's readiness and page authority when a verified
fatal error cannot be persisted. Allow the same native failure report to retry
its journal write without allowing the failed generation to confirm startup.
