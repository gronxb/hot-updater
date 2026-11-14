---
"@hot-updater/plugin-core": patch
---

fix(plugin-core): insert a row without deleting its index table entries first. A new row has none, and on SQL databases that delete read the whole index table, so every stored Insights event scanned `bundle_events__byBundle` (billed as rows read on D1).
