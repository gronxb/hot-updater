---
"hot-updater": minor
---

Add bulk deletion to `hot-updater bundle delete`. The command now accepts multiple bundle ids (`bundle delete <id...>`) or an entire channel (`bundle delete --channel <channel>`, optionally scoped with `--platform`). The channel form is cursor-paginated so large channels are fully covered, all targets are deleted with a single `commitBundle()` (fewer management-index rewrites and CDN invalidations than deleting one-by-one), and each removal is verified. The existing single-id form is unchanged.
