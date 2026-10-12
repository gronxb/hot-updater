---
"hot-updater": patch
---

Honor the build adapter's signing configuration source during deployment so
native public-key validation uses the same source as doctor. This allows signed
Lynx deployments with an adapter-owned native key while preserving the default
native-file validation for other integrations.
