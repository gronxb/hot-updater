---
"@hot-updater/server": minor
"@hot-updater/console": minor
---

Add opt-in built-in client access-key authentication backed by the official
`database.models.clientAccessKeys` domain. Setting
`features.clientAccessKeys: true` protects OTA reads and Analytics ingestion
with `x-api-key`; it does not grant Analytics reads or bundle and key management
access. The Console creates, lists, and revokes keys directly through the same
official database model.

Remove the separate Better Auth package, generic authentication provider,
managed route policy, universal component schema, and provisioning preset.
