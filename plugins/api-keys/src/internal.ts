/**
 * Not a public API: what `@hot-updater/server`'s own API key specs reach past
 * the plugin's entry for. It can change in any release.
 */
export {
  authenticateApiKey,
  createApiKey,
  createApiKeyManagement,
  hashApiKey,
  normalizeApiKeyHeaderName,
  provisionApiKey,
  registerApiKey,
} from "./server/apiKeys";
export { apiKeysCli, type ApiKeysCliApi } from "./server/cli";
