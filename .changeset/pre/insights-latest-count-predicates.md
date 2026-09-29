---
"@hot-updater/server": patch
"@hot-updater/plugin-core": patch
"@hot-updater/test-utils": patch
---

`countLatestEvents` counts an installation once when its latest event matches a `from` and a `to` bundle predicate of the same type, over whole hours as it already did over a partial hour. The Insights plugin sums one gauge per predicate, so a download from A to B counted by "from A" and "to B" was counted twice. Each installation's latest event now also keeps a gauge of its (from, to) pair, and the count subtracts the pairs its predicates share: one more gauge per latest event, read and written in the same batch as the others, and a count reads the pairs only when both fields are filtered. The published Insights model suite checks the case.
