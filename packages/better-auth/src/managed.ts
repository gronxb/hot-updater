import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";

import { isCanonicalBase64Url32 } from "./base64url";
import { betterAuthPlugin } from "./index";

const MANAGED_CONFIG_ID = "default";
const MANAGED_USER_ID = "hot-updater-managed";
const API_KEY_LENGTH = 43;
const RECORD_TIME = new Date(0);

export type ManagedBetterAuthPluginOptions = {
  readonly apiKeySha256: string;
};

class ManagedBetterAuthConfigurationError extends Error {
  constructor() {
    super("Managed Better Auth API-key SHA-256 projection is invalid.");
    this.name = "ManagedBetterAuthConfigurationError";
  }
}

export const managedBetterAuthPlugin = (
  options: ManagedBetterAuthPluginOptions,
) => {
  if (!isCanonicalBase64Url32(options.apiKeySha256)) {
    throw new ManagedBetterAuthConfigurationError();
  }

  const database: MemoryDB = {
    account: [],
    apikey: [
      {
        configId: MANAGED_CONFIG_ID,
        createdAt: RECORD_TIME,
        enabled: true,
        expiresAt: null,
        id: "hot-updater-managed-api-key",
        key: options.apiKeySha256,
        lastRefillAt: null,
        lastRequest: null,
        metadata: null,
        name: "Hot Updater managed API key",
        permissions: null,
        prefix: null,
        rateLimitEnabled: false,
        rateLimitMax: null,
        rateLimitTimeWindow: null,
        referenceId: MANAGED_USER_ID,
        refillAmount: null,
        refillInterval: null,
        remaining: null,
        requestCount: 0,
        start: null,
        updatedAt: RECORD_TIME,
      },
    ],
    session: [],
    user: [
      {
        createdAt: RECORD_TIME,
        email: "managed@hot-updater.invalid",
        emailVerified: true,
        id: MANAGED_USER_ID,
        image: null,
        name: "Hot Updater managed provider",
        updatedAt: RECORD_TIME,
      },
    ],
    verification: [],
  };
  const auth = betterAuth({
    baseURL: "https://hot-updater.invalid",
    database: memoryAdapter(database, { debugLogs: false }),
    logger: { disabled: true },
    plugins: [
      apiKey({
        configId: MANAGED_CONFIG_ID,
        customAPIKeyValidator: ({ key }) => isCanonicalBase64Url32(key),
        defaultKeyLength: API_KEY_LENGTH,
        deferUpdates: true,
        enableSessionForAPIKeys: true,
        keyExpiration: {
          defaultExpiresIn: null,
          disableCustomExpiresTime: true,
        },
        rateLimit: { enabled: false },
      }),
    ],
    secret: options.apiKeySha256,
    telemetry: { enabled: false },
  });

  return betterAuthPlugin({ auth });
};
