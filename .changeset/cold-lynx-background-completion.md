---
"@hot-updater/lynx": patch
---

Fix Android background tasks timing out after successful script execution by observing native module-manager teardown, which is available in the stock Lynx runtime without NAPI lifecycle listeners.
