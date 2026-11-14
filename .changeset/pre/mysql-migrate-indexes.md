---
"@hot-updater/plugin-core": patch
---

fix(plugin-core): `hot-updater db migrate` on MySQL creates the indexes a release adds to a table an earlier release created, such as `bundle_events__byBundle__key`. MySQL declares indexes in `CREATE TABLE`, which skips an existing table, so they were left out. It creates them before it writes the new schema settings.
