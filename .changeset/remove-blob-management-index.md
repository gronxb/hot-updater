---
"@hot-updater/aws": minor
"@hot-updater/plugin-core": minor
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
Blob database reads now reuse bundles already loaded in the same plugin instance,
reducing repeated canonical manifest scans for management mutations and
update-check follow-up lookups.
