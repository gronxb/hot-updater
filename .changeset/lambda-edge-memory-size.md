---
"@hot-updater/aws": patch
---

Apply the Lambda@Edge memory size on every deploy: `createFunction` now sets `MemorySize`, and updates publish a version only after the configuration change is applied.
