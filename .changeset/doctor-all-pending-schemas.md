---
"@hot-updater/plugin-core": patch
"hot-updater": patch
---

`hot-updater doctor` lists every pending schema setting in one run. When core's schema and a plugin's were both behind, such as `schema.core` 1.0.0 and a plugin's missing setting, `SCHEMA_MIGRATION_PENDING` named only `schema.core`, and the plugin's appeared after core was migrated. The schema fence over a server's plugins now checks core's settings with theirs in the same single read, so its refusal, the 503 message, doctor, and the Console list every setting missing or different. The fence passes and fails as before, with no extra read.
