---
"@hot-updater/server": patch
"@hot-updater/plugin-core": patch
---

`countLatestEvents` rejects bundle predicates on both fields that share a type. The Insights plugin sums one gauge per predicate, so an installation whose latest event matched both, such as a download from A to B counted by "from A" and "to B", was counted twice. The reporting overview's predicates never share a type and count as before.
