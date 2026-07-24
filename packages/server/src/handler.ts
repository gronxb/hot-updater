import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import { createCoreServerRoutes } from "./coreRoutes";
import type { HandlerAPI, HandlerOptions } from "./handlerTypes";
import { selectAuthenticationProvider } from "./kernel/authentication";
import type { HotUpdaterMatchedRoute } from "./kernel/contracts";
import { createCoreRouteDescriptors } from "./kernel/coreRoutes";
import { executeKernelRequest } from "./kernel/execute";
import { compileVersionMetadata } from "./kernel/metadata";
import { compileRoutes } from "./kernel/routeCompiler";
import { normalizeBasePath } from "./route";

export type { HandlerAPI, HandlerOptions } from "./handlerTypes";

const matchedRoute = (
  route: ReturnType<typeof createCoreServerRoutes>[number],
): HotUpdaterMatchedRoute =>
  Object.freeze({
    access: route.access,
    id: route.id,
    method: route.method,
    params: Object.freeze({}),
    pattern: route.path,
  });

export function createHandler<TContext = unknown>(
  api: HandlerAPI<TContext>,
  options: HandlerOptions = {},
): (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response> {
  const basePath = normalizeBasePath(options.basePath ?? "/api");
  const metadata = compileVersionMetadata({ contributions: [] });
  const routes = createCoreServerRoutes({
    api,
    descriptors: createCoreRouteDescriptors(options.coreRoutes),
    resolveMetadata: () => metadata,
  });
  const router = compileRoutes(routes);
  const authentication = selectAuthenticationProvider({
    providers: [],
    routes: routes.map(matchedRoute),
  });

  return (request, context) =>
    executeKernelRequest({
      authentication,
      basePath,
      middleware: [],
      platformContext: context,
      request,
      router,
    });
}
