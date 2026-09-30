import { definePlugin } from "../definePlugin";
import { markOfficial } from "../official";
import {
  API_KEY_HEADER_NAME,
  authenticateApiKey,
  createApiKeyManagement,
  normalizeApiKeyHeaderName,
  provisionApiKey,
  registerApiKey,
} from "./apiKeys";
import { apiKeysCli } from "./cli";
import { createApiKeyModel } from "./model";
import { apiKeysSchema } from "./schema";

export {
  API_KEY_HEADER_NAME,
  type ApiKeyManagementAPI,
  type ApiKeyMetadata,
  type CreatedApiKey,
} from "./apiKeys";
export { createApiKeyModel, type ApiKeyModel, type ApiKeyRow } from "./model";
export { apiKeysSchema, type ApiKeysSchema } from "./schema";

export interface ApiKeysOptions {
  /** The request header that carries the key; defaults to `x-api-key`. */
  readonly headerName?: string;
}

/**
 * API keys: protects client routes with keys whose SHA-256 digests
 * are stored, and manages them in-process.
 */
export const apiKeys = (options: ApiKeysOptions = {}) => {
  const headerName = normalizeApiKeyHeaderName(
    options.headerName ?? API_KEY_HEADER_NAME,
  );
  const plugin = definePlugin({
    id: "apiKeys",
    // Keeps its table's name, api_keys, and with it the camelCase id.
    namespace: false,
    provides: { clientAuth: true },
    schemaVersion: "1.0.0",
    schema: apiKeysSchema,
    init: ({ db }) => {
      const model = createApiKeyModel(db);
      return {
        api: {
          ...createApiKeyManagement({ apiKeys: model }),
          /** Registers a known plaintext key idempotently, for managed init. */
          register: (input: {
            readonly apiKey: string;
            readonly name: string;
            readonly createdAtMs?: number;
          }) => registerApiKey({ ...input, apiKeys: model }),
          /** Reuses a saved key or creates one, for managed init. */
          provision: (input: {
            readonly existingApiKey?: string;
            readonly name: string;
          }) => provisionApiKey({ ...input, apiKeys: model }),
        },
        clientAuth: {
          varyHeaders: [headerName],
          authenticate: (headers: Headers) =>
            authenticateApiKey({
              apiKeys: model,
              headerName,
              request: { headers } as Request,
            }),
        },
      };
    },
    cli: apiKeysCli(headerName),
  });
  // Only this factory may take the id; tooling and the console tell it by the mark.
  return markOfficial(plugin);
};
