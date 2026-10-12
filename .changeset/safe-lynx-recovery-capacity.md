---
"@hot-updater/lynx": patch
---

Keep a recovery slot available before restarting a confirmed OTA Release on
Android and iOS. If the retained failure history is full, choose an eligible
built-in fallback rather than starting code whose fatal failure cannot be saved.
Preserve every existing exclusion.
