---
"@hot-updater/server": minor
"@hot-updater/console": minor
---

Add built-in client access-key authentication backed by the official
`database.models.clientAccessKeys` domain. Every `createHotUpdater` call must
set `features.clientAccessKeys` explicitly. Setting it to `true` protects OTA
reads and Analytics ingestion with `x-api-key`; it does not grant Analytics
reads or bundle and key management access. The Console creates, lists, and
revokes keys directly through the same official database model.

Remove the separate Better Auth package, generic authentication provider,
managed route policy, universal component schema, and provisioning preset.
