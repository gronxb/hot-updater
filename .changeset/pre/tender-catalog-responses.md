---
"@hot-updater/protocol": patch
"@hot-updater/react-native": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"hot-updater": patch
"@hot-updater/test-utils": patch
---

Attach the latest catalog or artifact HTTP response to existing Insights reports without adding requests or changing launch/failure deduplication. Preserve successful, cached, and failed response text with a bounded body and its original observation timestamp. Console exposes the response from event and installation details and alongside error investigation. No database migration is required.
