---
"hot-updater": minor
---

Add bulk deletion to `hot-updater bundle delete`. The command now accepts multiple bundle ids (`bundle delete <id...>`), deleting all targets with a single `commitBundle()` (fewer management-index rewrites and CDN invalidations than deleting one-by-one) and verifying each removal. The existing single-id form is unchanged.
