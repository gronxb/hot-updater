---
"@hot-updater/plugin-core": patch
---

A Release Catalog no longer serves app versions in the gap between the parts of a release's range. Segments with the same releases merged across the empty segment between them, so a lone `1.2.x || 1.5.x` release was served to 1.4.0, and `1.0.0 || 2.0.0` to 1.5.0; auto-patch bases paired those versions too. A catalog compiled before keeps the gap until its scope changes or `hot-updater db catalog rebuild` recompiles it.
