import {
  defineFirstPartyFeatureManifest,
  type NoFeatureApiKind,
} from "@hot-updater/server/internal/first-party-plugin";

import packageJson from "../package.json" with { type: "json" };
import {
  createApiKeyAuthenticationProvider,
  type BetterAuthApiKeyConfiguration,
  type BetterAuthApiKeyConfiguredInstance,
} from "./apiKeyAuthentication";
import {
  createSessionAuthenticationProvider,
  type BetterAuthSessionConfiguredInstance,
} from "./sessionAuthentication";

export type {
  BetterAuthApiKeyConfiguration,
  BetterAuthApiKeyConfiguredInstance,
} from "./apiKeyAuthentication";
export type {
  BetterAuthSession,
  BetterAuthSessionConfiguredInstance,
} from "./sessionAuthentication";

export type BetterAuthConfiguredInstance = BetterAuthSessionConfiguredInstance;

export type BetterAuthSessionPluginOptions = {
  readonly apiKey?: never;
  readonly auth: BetterAuthSessionConfiguredInstance;
};

export type BetterAuthApiKeyPluginOptions = {
  readonly apiKey: BetterAuthApiKeyConfiguration;
  readonly auth: BetterAuthApiKeyConfiguredInstance;
};

export type BetterAuthPluginOptions =
  | BetterAuthApiKeyPluginOptions
  | BetterAuthSessionPluginOptions;

export const betterAuthPlugin = (options: BetterAuthPluginOptions) => {
  if (options.apiKey === undefined) {
    const authentication = createSessionAuthenticationProvider(options.auth);
    return defineFirstPartyFeatureManifest<
      "better-auth",
      NoFeatureApiKind,
      Record<never, never>
    >({
      aliases: {},
      id: "better-auth",
      namespace: "better-auth",
      setup: () => ({ authentication }),
      version: packageJson.version,
    });
  }

  const authentication = createApiKeyAuthenticationProvider(
    options.auth,
    options.apiKey,
  );
  return defineFirstPartyFeatureManifest<
    "better-auth",
    NoFeatureApiKind,
    Record<never, never>
  >({
    aliases: {},
    id: "better-auth",
    namespace: "better-auth",
    setup: () => ({
      authentication,
      routePolicy: Object.freeze({ kind: "protect-all" }),
    }),
    version: packageJson.version,
  });
};
