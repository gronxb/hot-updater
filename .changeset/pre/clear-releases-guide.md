---
"@hot-updater/core": minor
"hot-updater": minor
---

Align the CLI with the Release Catalog ownership model. Deploy now reports the
committed Release and Catalog handles, Release commands expose and preview
policy state, Bundle commands report Release references, missing Catalog
projections can be rebuilt, and storage pruning safely reclaims unreferenced
patch objects below live Bundle prefixes.

Remove the ambiguous top-level Bundle-targeted rollback command. Use
`hot-updater release disable <release-id>` to roll back an exact Release.
