import {
  defineFirstPartyFeatureManifest,
  type NoFeatureApiKind,
} from "@hot-updater/server/internal/first-party-plugin";

import packageJson from "../package.json" with { type: "json" };
import {
  createSessionAuthenticationProvider,
  type BetterAuthSessionConfiguredInstance,
} from "./sessionAuthentication";

export type {
  BetterAuthSession,
  BetterAuthSessionConfiguredInstance,
} from "./sessionAuthentication";

export type BetterAuthConfiguredInstance = BetterAuthSessionConfiguredInstance;

export type BetterAuthPluginOptions = {
  readonly auth: BetterAuthSessionConfiguredInstance;
};

export const betterAuthPlugin = (options: BetterAuthPluginOptions) => {
  const authentication = createSessionAuthenticationProvider(options.auth);
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
