---
"@hot-updater/protocol": patch
"@hot-updater/react-native": patch
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
---

Remove crash exit reasons. Android 11 and later reported only why the previous process exited, such as `CRASH` or `ANR`, with no stack trace or message, and iOS reported nothing, so they could not show what crashed. The SDK no longer reads `ApplicationExitInfo` or sends `previousProcessExit`. `AppReadyResult` and `UpdateError` drop the field, Insights keeps no exit-reason rows, `getUpdateFailures` drops `recoveries`, and the Console drops **Crashes by exit reason**. A bundle's crash count in Release health is no longer a link. The server still accepts reports from SDKs that send the field and ignores it. Update failure reads count only the stages a failure records, so exit-reason rows already stored are ignored until they expire.

The Insights schema version is 1.0.0, as core's is, while the 1.0.0 baseline changes in place: set the `schema.insights` setting to `1.0.0`. The Console's tooltips are shorter.
