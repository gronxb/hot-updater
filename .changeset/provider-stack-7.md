---
"@hot-updater/firebase": patch
---

Replace Firebase transaction query emulation with keyed staging and explicit relation reads. Cache missing keys and preserve staged deletions until the native transaction persists its writes.
