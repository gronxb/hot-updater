import { analytics } from "@hot-updater/analytics";
import {
  managedBetterAuthPlugin,
  managedRoutePolicy,
  type ManagedBetterAuthPluginOptions,
} from "@hot-updater/better-auth/managed";
import type { HotUpdaterServerPlugin } from "@hot-updater/server";

export type ManagedServerPluginOptions = Pick<
  ManagedBetterAuthPluginOptions,
  "managementBearerToken"
>;

export const createManagedServerPlugins = (
  options: ManagedServerPluginOptions = {},
): readonly HotUpdaterServerPlugin[] =>
  Object.freeze([
    managedBetterAuthPlugin({
      managementBearerToken: options.managementBearerToken,
    }),
    managedRoutePolicy({ scope: "client" }),
    analytics(),
  ]);
