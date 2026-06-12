---
"@hot-updater/aws": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": patch
---

Remove blob database management index artifacts. Console reads now use canonical
update manifests, and AWS deployments no longer write `_index` metadata.
Target app version manifests are updated from commit changes without listing S3.
AWS database metadata now uses single PutObject writes instead of multipart upload.
AWS canonical manifest scans now use S3 delimiters to avoid reading asset object
lists during console-style bundle lookups.
AWS recursive manifest listing now uses bounded concurrency to avoid S3 SlowDown
when E2E shards query bundle metadata in parallel.
Blob database instances now remember locally committed deletions so immediate
delete verification does not reload canonical manifests.
Plugin-core now owns a request-scoped bundle unit-of-work / identity map. Within
one request, repeated bundle reads reuse the same value, pending updates and
deletes are reflected in `getBundleById` and query-aware `getBundles` results,
and commit clears the pending state.
Provider implementations continue to implement only reads and writes; they do
not need to manage identity-map caching themselves. No-context reads no longer
persist stale identity entries across logical requests, while no-context mutation
staging remains available until commit for existing CLI-style flows.
Server update-info artifact resolution reuses the request identity map instead
of adding duplicate bundle reads for manifest artifact lookup.
Canonical blob reloads now clear provider-local pending state so another plugin
instance's committed manifest update is visible through the canonical path.
