---
"@hot-updater/better-auth": minor
---

Add opt-in Better Auth authentication, scoped managed client access keys,
explicit client, management, or all-route policies, and Node-only first-key
provisioning. Managed client keys allow only OTA reads and Analytics writes,
persist through a Better Auth-owned universal component schema, and support
multiple active keys with create, list, and revoke lifecycle operations without
teaching database plugins the access-key contract.
Optionally authenticate an external management bearer token at self-hosted
composition roots without granting managed client keys management access.
