import { defineFirstPartyServerPlugin } from "@hot-updater/server/internal/first-party-plugin";
import type { HotUpdaterAuthenticationInput } from "@hot-updater/server/internal/first-party-plugin";

import {
  authorizeManagedAccessKeyRole,
  hashManagedAccessKey,
  MANAGED_ACCESS_KEY_HEADER_NAME,
  managedAccessKeyStoreCapability,
  parseManagedAccessKeyStore,
  type ManagedAccessKeyStore,
} from "./managed/accessKeys";

export * from "./managed/accessKeys";

export type ManagedBetterAuthPluginOptions = {
  readonly managementBearerToken?: string;
  readonly store?: ManagedAccessKeyStore;
};

export type ManagedRoutePolicyOptions = {
  readonly scope: "all" | "client" | "management";
};

const managementPublicRouteIds = Object.freeze([
  "core.version",
  "core.update.fingerprint",
  "core.update.fingerprint-cohort",
  "core.update.app-version",
  "core.update.app-version-cohort",
] as const);

class ManagedRoutePolicyConfigurationError extends Error {
  constructor() {
    super(
      'Managed route policy scope must be "management", "client", or "all".',
    );
    this.name = "ManagedRoutePolicyConfigurationError";
  }
}

const permissionForRoute = (
  routeId: string,
):
  | { readonly analytics: readonly ["write"] }
  | { readonly ota: readonly ["read"] }
  | null => {
  if (routeId.startsWith("core.update.")) return { ota: ["read"] };
  if (routeId === "analytics.appendBundleEvent") {
    return { analytics: ["write"] };
  }
  return null;
};

const createManagedAuthentication = (
  store: ManagedAccessKeyStore,
  managementBearerToken?: string,
) =>
  Object.freeze({
    id: "better-auth-managed-access-key",
    async authenticate(input: HotUpdaterAuthenticationInput) {
      if (
        managementBearerToken !== undefined &&
        input.headers.get("authorization") === `Bearer ${managementBearerToken}`
      ) {
        return Object.freeze({
          kind: "authenticated" as const,
          principal: Object.freeze({
            issuer: "hot-updater-managed",
            subject: "management-token",
          }),
        });
      }
      const permission = permissionForRoute(input.route.id);
      if (permission === null)
        return Object.freeze({ kind: "anonymous" as const });
      const apiKey = input.headers.get(MANAGED_ACCESS_KEY_HEADER_NAME);
      if (apiKey === null) return Object.freeze({ kind: "anonymous" as const });
      let hash: string;
      try {
        hash = await hashManagedAccessKey(apiKey);
      } catch {
        return Object.freeze({ kind: "anonymous" as const });
      }
      const record = await store.findByHash(hash);
      if (
        record === null ||
        !record.enabled ||
        record.revokedAt !== null ||
        !authorizeManagedAccessKeyRole(record.role, permission)
      ) {
        return Object.freeze({ kind: "anonymous" as const });
      }
      return Object.freeze({
        kind: "authenticated" as const,
        principal: Object.freeze({
          issuer: "better-auth",
          subject: record.id,
        }),
      });
    },
  });

export const managedBetterAuthPlugin = (
  options: ManagedBetterAuthPluginOptions = {},
) => {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    Reflect.ownKeys(options).some(
      (key) => key !== "managementBearerToken" && key !== "store",
    )
  ) {
    throw new TypeError("Managed Better Auth options must be an object.");
  }
  const managementBearerToken = options.managementBearerToken;
  if (
    managementBearerToken !== undefined &&
    (typeof managementBearerToken !== "string" ||
      managementBearerToken.length === 0)
  ) {
    throw new TypeError(
      "Managed Better Auth managementBearerToken must be a non-empty string.",
    );
  }
  const configuredStore =
    options.store === undefined
      ? undefined
      : parseManagedAccessKeyStore(options.store);
  return defineFirstPartyServerPlugin({
    id: "better-auth-managed-access-key",
    requires:
      configuredStore === undefined
        ? [{ missing: "error", token: managedAccessKeyStoreCapability }]
        : [],
    setup: ({ capabilities }) => ({
      authentication: createManagedAuthentication(
        configuredStore ??
          capabilities.require(managedAccessKeyStoreCapability),
        managementBearerToken,
      ),
    }),
  });
};

export const managedRoutePolicy = (options: ManagedRoutePolicyOptions) => {
  const scope =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "scope")
      : undefined;
  if (scope !== "all" && scope !== "client" && scope !== "management") {
    throw new ManagedRoutePolicyConfigurationError();
  }

  const routePolicy =
    scope === "all"
      ? Object.freeze({ kind: "protect-all" as const })
      : Object.freeze({
          kind: "protect-except-core" as const,
          routeIds:
            scope === "management"
              ? managementPublicRouteIds
              : Object.freeze(["core.version"] as const),
        });
  return defineFirstPartyServerPlugin({
    id: "managed-auth-route-policy",
    setup: () => ({ routePolicy }),
  });
};
