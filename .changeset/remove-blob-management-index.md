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
