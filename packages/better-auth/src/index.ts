import { defineFirstPartyServerPlugin } from "@hot-updater/server/internal/first-party-plugin";

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
  return defineFirstPartyServerPlugin({
    id: "better-auth",
    setup: () => ({ authentication }),
  });
};
