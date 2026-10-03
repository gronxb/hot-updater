---
"@hot-updater/aws": patch
---

`s3Storage().listObjects()` returns each object's `storageUri` as `put` returns it, with every key segment encoded. It returned the raw key, so for a key with `#`, `%`, `@`, or `+` the URI did not match the one a Bundle stores, and `hot-updater storage prune` could treat a referenced object as unreferenced. Keys that no `put` writes, such as folder markers that end in `/`, are no longer listed.
