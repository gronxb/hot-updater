---
"@hot-updater/lynx": patch
"@hot-updater/lynx-sparkling": patch
---

Retain iOS native failure authority after page readiness and cancel unrelated pending admissions without attributing a fatal error to them. Retry failed recovery recording once, then close managed runtimes and retain a process-scoped admission block if persistence remains unavailable.
