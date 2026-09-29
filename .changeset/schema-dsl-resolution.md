---
"@hot-updater/server": minor
---

Add the schema DSL that core and plugins declare their tables with, exported from `@hot-updater/server/plugins` and `@hot-updater/server/database`. `defineTable` declares fields (with `required`, `unique`, `maxLength`, and `references` that `restrict`, `cascade`, or do nothing on delete), derived fields computed on write (single or up to 16 values), and indexes by `eq` and `sort` fields, optionally unique or rooted at a parent table. `defineAggregate` declares identity fields with counters, gauges, or distinct sketches and a fixed shard count. Index declarations that name an undeclared field fail to type-check with a message naming the field.

`resolveSchema` turns module schemas into physical tables with engine columns (`_v`, per-relation `_refs_<table>_<column>` counters, `_shard`), unique-field indexes, reference metadata, and roots, namespacing third-party modules. `validateSchema` rejects every invalid declaration at once, including nullable or json key fields, a misordered aggregate key, sketches mixed with counters, unknown roots or reference targets, cascades without an index, and multi-valued sort fields.
