---
"@hot-updater/firebase": patch
"@hot-updater/plugin-core": patch
---

Replace Firebase transaction query emulation with keyed staging and explicit relation reads. Cache missing keys and preserve staged deletions until the native transaction persists its writes. Use bounded, ID-only release `findOne` witnesses for commit reference checks, including staged inserts and deletions, and delete staged rows by their stored primary key. Preserve full staged rows during projected validation and reject channel ID collisions even when a name conflict would otherwise be ignored. Keep transactional counts exact and project core reference checks to their required fields.
