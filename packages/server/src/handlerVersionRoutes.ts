import { ADMIN_API_PROTOCOL } from "./handlerAdminRoutes";
import type { RouteHandler } from "./handlerTypes";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

export const HOT_UPDATER_INFRASTRUCTURE_GENERATION = 1;

/**
 * `/version` on both mounts. The admin mount also lists the ids of the
 * plugins the server runs, sorted; apps never learn which plugins a server
 * runs. No cache keeps it: tooling reads it right after a deploy, when a
 * kept answer would name the previous version.
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
  const noStore = { headers: { "cache-control": "no-store" } };
  return {
    version: async () => Response.json(version, noStore),
    adminVersion: async () => Response.json(adminVersion, noStore),
  };
};
