import {
  createAnalyticsRouteHandlers,
  registerAnalyticsAdminRoutes,
  registerAnalyticsClientRoutes,
} from "./analytics/routes";
import type { AnalyticsProvider } from "./analytics/types";
import { createBundleRouteHandlers } from "./handlerBundleRoutes";
import { HandlerBadRequestError } from "./handlerErrors";
import { createReleaseCatalogRouteHandlers } from "./handlerReleaseCatalogRoutes";
import { createReleaseManagementRouteHandlers } from "./handlerReleaseManagementRoutes";
import type {
  HandlerAPI,
  HotUpdaterHandler,
  HotUpdaterHandlers,
  RouteHandler,
} from "./handlerTypes";
import { createVersionRouteHandlers } from "./handlerVersionRoutes";
import { addRoute, createRouter, findRoute } from "./internalRouter";

export type {
  HandlerAPI,
  HotUpdaterHandler,
  HotUpdaterHandlers,
} from "./handlerTypes";

const withPrivateNoStore = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const errorResponse = (error: string, status: number): Response =>
  Response.json(
    { error },
    {
      headers: { "cache-control": "private, no-store" },
      status,
    },
  );

const requiresApiKey = (handlerName: string): boolean =>
  handlerName === "appVersionReleaseCatalog" ||
  handlerName === "fingerprintReleaseCatalog" ||
  handlerName === "artifact" ||
  handlerName === "appendBundleEvent";

const createRequestHandler =
  ({
    api,
    apiKeyAuth,
    privateResponses = false,
    routeHandlers,
    router,
  }: {
    readonly api: HandlerAPI;
    readonly apiKeyAuth?: {
      readonly authenticate: (request: Request) => Promise<boolean>;
    };
    readonly privateResponses?: boolean;
    readonly routeHandlers: Record<string, RouteHandler>;
    readonly router: ReturnType<typeof createRouter<string>>;
  }): HotUpdaterHandler =>
  async (request): Promise<Response> => {
    try {
      const match = findRoute(
        router,
        request.method,
        new URL(request.url).pathname,
      );
      if (!match) {
        return errorResponse("Not found", 404);
      }

      if (apiKeyAuth !== undefined && requiresApiKey(match.data)) {
        let authenticated: boolean;
        try {
          authenticated = await apiKeyAuth.authenticate(request);
        } catch {
          return errorResponse("Service unavailable", 503);
        }
        if (!authenticated) {
          return errorResponse("Unauthorized", 401);
        }
      }

      const handler = routeHandlers[match.data];
      if (!handler) {
        return errorResponse("Handler not found", 500);
      }
      const response = await handler(match.params, request, api);
      return privateResponses ? withPrivateNoStore(response) : response;
    } catch (error) {
      if (error instanceof HandlerBadRequestError) {
        return errorResponse(error.message, 400);
      }
      console.error("Hot Updater handler error:", error);
      return Response.json(
        { error: "Internal server error" },
        {
          headers: { "cache-control": "private, no-store" },
          status: 500,
        },
      );
    }
  };

const createDownloadStorageRouteHandler =
  (
    downloadStorageObject: (
      token: string,
      signature: string,
    ) => Promise<Response | null>,
  ): RouteHandler =>
  async (params) => {
    const token = params.token;
    const signature = params.signature;
    if (!token || !signature) {
      return errorResponse("Not found", 404);
    }
    const response = await downloadStorageObject(token, signature);
    if (!response) {
      return errorResponse("Not found", 404);
    }
    const headers = new Headers(response.headers);
    if (!headers.has("cache-control")) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    }
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

export function createHandlers(api: HandlerAPI): HotUpdaterHandlers {
  return createHotUpdaterHandlers(api);
}

export function createHotUpdaterHandlers(
  api: HandlerAPI,
  analytics?: AnalyticsProvider,
  apiKeyAuth?: {
    readonly authenticate: (request: Request) => Promise<boolean>;
    readonly headerName: string;
  },
  downloadStorageObject?: (
    token: string,
    signature: string,
  ) => Promise<Response | null>,
): HotUpdaterHandlers {
  const routeHandlers: Record<string, RouteHandler> = {
    ...createVersionRouteHandlers(),
    ...createReleaseCatalogRouteHandlers(apiKeyAuth?.headerName),
    ...createReleaseManagementRouteHandlers(),
    ...createBundleRouteHandlers(),
    ...(analytics === undefined ? {} : createAnalyticsRouteHandlers(analytics)),
    ...(downloadStorageObject === undefined
      ? {}
      : {
          downloadStorageObject: createDownloadStorageRouteHandler(
            downloadStorageObject,
          ),
        }),
  };

  const clientRouter = createRouter<string>();
  const addClientRoute = (
    method: string,
    path: string,
    handler: string,
  ): void => addRoute(clientRouter, method, path, handler);
  addClientRoute("GET", "/version", "version");
  if (downloadStorageObject !== undefined) {
    addClientRoute(
      "GET",
      "/storage/:token/:signature",
      "downloadStorageObject",
    );
  }
  addClientRoute(
    "GET",
    "/release-catalogs/app-version/:platform/:channelKey/:appVersion",
    "appVersionReleaseCatalog",
  );
  addClientRoute(
    "GET",
    "/release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash",
    "fingerprintReleaseCatalog",
  );
  addClientRoute(
    "GET",
    "/artifacts/:targetBundleId/from/:currentBundleId",
    "artifact",
  );
  if (analytics !== undefined) {
    registerAnalyticsClientRoutes(addClientRoute);
  }

  const adminRouter = createRouter<string>();
  const addAdminRoute = (method: string, path: string, handler: string): void =>
    addRoute(adminRouter, method, path, handler);
  addAdminRoute("GET", "/releases/:id", "getRelease");
  addAdminRoute("GET", "/releases", "getReleases");
  addAdminRoute("PATCH", "/releases/:id", "updateRelease");
  addAdminRoute("POST", "/releases/:id/preflight", "preflightRelease");
  addAdminRoute("DELETE", "/releases/:id", "deleteRelease");
  addAdminRoute("GET", "/release-catalogs/:scopeKey", "getReleaseCatalogRow");
  addAdminRoute("GET", "/release-catalogs", "getReleaseCatalogs");
  addAdminRoute(
    "POST",
    "/release-catalogs/:scopeKey/rebuild",
    "rebuildReleaseCatalog",
  );
  addAdminRoute("POST", "/database/commit", "commitDatabase");
  addAdminRoute("GET", "/channels", "getChannels");
  addAdminRoute("POST", "/channels", "createChannel");
  addAdminRoute("DELETE", "/channels/:id", "deleteChannel");
  addAdminRoute("GET", "/bundles/:id", "getBundle");
  addAdminRoute("GET", "/bundles", "getBundles");
  addAdminRoute("POST", "/bundles", "createBundles");
  addAdminRoute("PATCH", "/bundles/:id", "updateBundle");
  addAdminRoute("DELETE", "/bundles/:id", "deleteBundle");
  if (analytics !== undefined) {
    registerAnalyticsAdminRoutes(addAdminRoute);
  }

  return Object.freeze({
    client: createRequestHandler({
      api,
      apiKeyAuth,
      routeHandlers,
      router: clientRouter,
    }),
    admin: createRequestHandler({
      api,
      privateResponses: true,
      routeHandlers,
      router: adminRouter,
    }),
  });
}
