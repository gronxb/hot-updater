---
"@hot-updater/plugin-core": patch
---

fix(plugin-core): prune a multi-valued index's entries on SQLite (Cloudflare D1) by the expired rows' keys. Each retention pass read the whole index table, such as `bundle_events__byBundle`, and every expired row on SQLite, instead of the rows it deletes.
