---
"@hot-updater/server": minor
---

Add the built-in API keys plugin at `@hot-updater/server/plugins/api-keys`. `apiKeys({ headerName })` declares v1's `api_keys` columns, including `prefix` and `role`, with a unique `hash` and a `byCreated` index.

- **clientAuth:** it provides `clientAuth` through the unchanged `authenticateApiKey`, so only active keys whose SHA-256 digest is stored pass. Client routes vary by the configured header, and a storage failure answers 503.
- **Managing keys:** `hotUpdater.api.apiKeys` creates keys (plaintext returned once), lists and revokes them without hashes, and registers or provisions a saved key idempotently for managed init.
- **Legacy façade:** `createApiKeyModel(db)` serves today's `ApiKeyModel` on the plugin's tables for the legacy façade.
