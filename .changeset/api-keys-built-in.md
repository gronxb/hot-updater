---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/console": minor
"@hot-updater/test-utils": minor
"@hot-updater/cli-tools": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/mock": minor
"@hot-updater/postgres": minor
"@hot-updater/supabase": minor
"hot-updater": minor
---

Add built-in API key authentication backed by the official
`database.models.apiKeys` domain. Every `createHotUpdater` call must set
`clientAccess` explicitly. `{ type: "api-key" }` protects OTA reads and
Analytics ingestion with `x-api-key` by default; it does not grant Analytics
query, Bundle management, or API key management access.

Add `hot-updater api-key create`, `list`, and `revoke` for self-hosted
deployments. Creation returns the plaintext API key exactly once, while the
database stores only its SHA-256 hash and non-secret metadata. Managed AWS init
uses the same API key domain and persists the plaintext only in the local
`HOT_UPDATER_API_KEY` environment entry. Console API key management uses the
same domain directly. `createHotUpdater(...).apiKeys` exposes the common local
create, list, and revoke management API without adding an HTTP management route.
Self-hosted setup now recommends the `api-key` client policy: migrate the direct
database, create a key from the same config, then pass the one-time plaintext to
React Native through `x-api-key`. The `public` policy remains an explicit
unauthenticated alternative.

Rename the pre-release public API and storage terminology from Client Access
Key to API Key, including `database.models.apiKeys`, `ApiKeyModel`,
`ApiKeyRow`, `createApiKey`, and `registerApiKey`. Fresh v1 provider schemas use
the canonical API key naming and do not migrate or reuse v0 databases.

Remove the separate Better Auth package, generic authentication provider,
managed route policy, universal component schema, and provisioning preset.
