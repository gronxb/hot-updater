---
"hot-updater": patch
---

Use installed package versions when doctor checks local tarballs and other
non-semver dependency specifiers. Preserve declared semver-range comparisons and
report unresolved installations instead of comparing package locations as versions.
