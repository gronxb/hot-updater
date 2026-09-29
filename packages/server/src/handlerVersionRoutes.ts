import { ADMIN_API_PROTOCOL } from "./handlerAdminRoutes";
import type { RouteHandler } from "./handlerTypes";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

export const HOT_UPDATER_INFRASTRUCTURE_GENERATION = 1;

export const createVersionRouteHandlers = (): Record<string, RouteHandler> => ({
  version: async () =>
    Response.json({
      adminProtocol: ADMIN_API_PROTOCOL,
      infrastructureGeneration: HOT_UPDATER_INFRASTRUCTURE_GENERATION,
      version: HOT_UPDATER_SERVER_VERSION,
    }),
});
