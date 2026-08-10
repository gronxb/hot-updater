import { analytics } from "@hot-updater/analytics";
import {
  managedBetterAuthPlugin,
  managedRoutePolicy,
} from "@hot-updater/better-auth/managed";
import type { HotUpdaterServerPlugin } from "@hot-updater/server";

export const createManagedServerPlugins =
  (): readonly HotUpdaterServerPlugin[] =>
    Object.freeze([
      managedBetterAuthPlugin(),
      managedRoutePolicy({ scope: "client" }),
      analytics(),
    ]);
