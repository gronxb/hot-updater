import { apiKey } from "@better-auth/api-key";
import { defineFirstPartyServerPlugin } from "@hot-updater/server/internal/first-party-plugin";
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

export type ManagedRoutePolicyOptions = {
  readonly scope: "all" | "management";
};

const managementPublicRouteIds = Object.freeze([
  "core.version",
  "core.update.fingerprint",
  "core.update.fingerprint-cohort",
  "core.update.app-version",
  "core.update.app-version-cohort",
] as const);

class ManagedBetterAuthConfigurationError extends Error {
  constructor() {
    super("Managed Better Auth API-key SHA-256 projection is invalid.");
    this.name = "ManagedBetterAuthConfigurationError";
  }
}

class ManagedRoutePolicyConfigurationError extends Error {
  constructor() {
    super('Managed route policy scope must be "management" or "all".');
    this.name = "ManagedRoutePolicyConfigurationError";
  }
}

export const managedBetterAuthPlugin = (
  options: ManagedBetterAuthPluginOptions,
) => {
  const apiKeySha256 =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "apiKeySha256")
      : undefined;
  if (
    typeof apiKeySha256 !== "string" ||
    !isCanonicalBase64Url32(apiKeySha256)
  ) {
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
        key: apiKeySha256,
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
    secret: apiKeySha256,
    telemetry: { enabled: false },
  });

  return betterAuthPlugin({ auth });
};

export const managedRoutePolicy = (options: ManagedRoutePolicyOptions) => {
  const scope =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "scope")
      : undefined;
  if (scope !== "all" && scope !== "management") {
    throw new ManagedRoutePolicyConfigurationError();
  }

  const routePolicy =
    scope === "all"
      ? Object.freeze({ kind: "protect-all" as const })
      : Object.freeze({
          kind: "protect-except-core" as const,
          routeIds: managementPublicRouteIds,
        });
  return defineFirstPartyServerPlugin({
    id: "managed-auth-route-policy",
    setup: () => ({ routePolicy }),
  });
};
