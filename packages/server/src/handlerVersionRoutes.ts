import { ADMIN_API_PROTOCOL } from "./handlerAdminRoutes";
import type { RouteHandler } from "./handlerTypes";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

export const HOT_UPDATER_INFRASTRUCTURE_GENERATION = 1;

/**
 * `/version` on both mounts. The admin mount also lists the ids of the
 * plugins the server runs, sorted, so a console shows only the features they
 * serve; apps never learn which plugins a server runs.
 */
export const createVersionRouteHandlers = (
  plugins: readonly string[] = [],
): Record<string, RouteHandler> => {
  const version = {
    adminProtocol: ADMIN_API_PROTOCOL,
    infrastructureGeneration: HOT_UPDATER_INFRASTRUCTURE_GENERATION,
    version: HOT_UPDATER_SERVER_VERSION,
  };
  const adminVersion = { ...version, plugins: [...plugins].sort() };
  return {
    version: async () => Response.json(version),
    adminVersion: async () => Response.json(adminVersion),
  };
};
