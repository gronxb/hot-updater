---
"hot-updater": patch
---

Keep the v0 bundle mental model while using the console update ID everywhere. Deploy now prints that ID once in its final success area, and `bundle list`, `show`, `update`, `preflight`, `enable`, `disable`, `delete`, and `promote` all accept the same ID. The prerelease `release` command is removed. Immutable-file cleanup moves to Advanced `bundle artifact delete <artifact-id>`, and patch creation uses `--artifact-id` and `--base-artifact-id` (with the old bundle-named flags retained as hidden aliases). Raw JSON and internal database fields remain unchanged.
