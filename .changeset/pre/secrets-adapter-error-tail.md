---
"@hot-updater/cli-tools": patch
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
---

`secrets put`, `secrets import`, and `secrets pull` print a secrets adapter's whole read error, with the step that fixes it, such as the command that signs in, the permission the identity needs, or `aws secretsmanager restore-secret`: they printed only its first line. Init prints the adapter's error under one head line instead of two. `secretsManager()`'s `set` waits until a read returns the version it wrote, so `secrets import --replace` no longer fails with "did not read back" while Secrets Manager still serves the previous version, and an issued key isn't revoked over a stale read. `secretManager()` names the configured project in the command that enables the Secret Manager API. A refusal to replace a stored secret starts with a capital.
