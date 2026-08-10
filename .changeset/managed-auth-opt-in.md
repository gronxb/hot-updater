---
"@hot-updater/better-auth": minor
---

Add opt-in Better Auth authentication, scoped managed client access keys,
explicit client, management, or all-route policies, and Node-only first-key
provisioning. Managed client keys allow only OTA reads and Analytics writes,
use provider-owned read-only hash lookup during requests, and support multiple
active keys with create, list, and revoke lifecycle operations.
Optionally authenticate an external management bearer token at self-hosted
composition roots without granting managed client keys management access.
