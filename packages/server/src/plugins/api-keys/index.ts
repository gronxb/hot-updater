import {
  API_KEY_HEADER_NAME,
  authenticateApiKey,
  createApiKeyManagement,
  normalizeApiKeyHeaderName,
  provisionApiKey,
  registerApiKey,
} from "../../apiKeys";
import { markBuiltIn } from "../builtIn";
import { definePlugin } from "../definePlugin";
import { createApiKeyModel } from "./model";
import { apiKeysSchema } from "./schema";

export { createApiKeyModel } from "./model";
export { apiKeysSchema, type ApiKeysSchema } from "./schema";

export interface ApiKeysOptions {
  /** The request header that carries the key; defaults to `x-api-key`. */
  readonly headerName?: string;
}

/**
 * Built-in API keys: protects client routes with keys whose SHA-256 digests
 * are stored, and manages them in-process.
 */
export const apiKeys = (options: ApiKeysOptions = {}) => {
  const headerName = normalizeApiKeyHeaderName(
    options.headerName ?? API_KEY_HEADER_NAME,
  );
  return markBuiltIn(
    definePlugin({
      id: "apiKeys",
      provides: { clientAuth: true },
      schemaVersion: "1.0.0",
      schema: apiKeysSchema,
      init: ({ db }) => {
        const model = createApiKeyModel(db);
        return {
          api: {
            ...createApiKeyManagement({
              apiKeys: model,
              beforeOperation: async () => undefined,
            }),
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
    }),
  );
};
