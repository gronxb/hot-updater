import type { MountedEndpoint } from "./assembly/assemblePlugins";
import { HotUpdaterConfigError } from "./assembly/assemblePlugins";
import { HotUpdaterSchemaMigrationRequiredError } from "./database/fence";
import { ADMIN_ROUTES, createAdminRouteHandlers } from "./handlerAdminRoutes";
import { HandlerBadRequestError } from "./handlerErrors";
import { createReleaseCatalogRouteHandlers } from "./handlerReleaseCatalogRoutes";
import type {
  HandlerAPI,
  HotUpdaterHandler,
  HotUpdaterHandlers,
  RouteHandler,
} from "./handlerTypes";
import { createVersionRouteHandlers } from "./handlerVersionRoutes";
import { INSIGHTS_ROUTES, insightsDisabled } from "./insights/routes";
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

/** The client-route policy: the clientAuth of the plugin that provides it. */
export interface ClientRoutePolicy {
  /** Request headers the decision reads; added to `Vary` on cacheable responses. */
  readonly varyHeaders: readonly string[];
  readonly authenticate: (request: Request) => Promise<boolean>;
}

/** `/version` and storage downloads never pass through the client policy. */
const PUBLIC_CLIENT_ROUTES = new Set(["version", "downloadStorageObject"]);

export type RouteAccess = "public" | "client" | "admin";

export interface HotUpdaterRoute {
  readonly method: string;
  readonly path: string;
  readonly access: RouteAccess;
}

const routesOf = Symbol.for("@hot-updater/server/routes");

/** Every mounted route, for the route snapshot. */
export const listHotUpdaterRoutes = (
  handlers: HotUpdaterHandlers,
): readonly HotUpdaterRoute[] =>
  (handlers as { readonly [routesOf]?: readonly HotUpdaterRoute[] })[
    routesOf
  ] ?? [];

const withVary = (response: Response, varyHeaders: readonly string[]) => {
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (
    varyHeaders.length === 0 ||
    cacheControl === "" ||
    /private|no-store/u.test(cacheControl)
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(
    "vary",
    [response.headers.get("vary"), ...varyHeaders].filter(Boolean).join(", "),
  );
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const createRequestHandler =
  ({
    api,
    clientPolicy,
    privateResponses = false,
    routeHandlers,
    router,
  }: {
    readonly api: HandlerAPI;
    readonly clientPolicy?: ClientRoutePolicy;
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

      const guarded =
        clientPolicy !== undefined && !PUBLIC_CLIENT_ROUTES.has(match.data);
      if (guarded) {
        let authenticated: boolean;
        try {
          authenticated = await clientPolicy.authenticate(request);
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
      if (privateResponses) return withPrivateNoStore(response);
      return guarded ? withVary(response, clientPolicy.varyHeaders) : response;
    } catch (error) {
      if (error instanceof HandlerBadRequestError) {
        return errorResponse(error.message, 400);
      }
      if (error instanceof HotUpdaterSchemaMigrationRequiredError) {
        console.error(error.message);
        return errorResponse("Service unavailable", 503);
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

export interface HotUpdaterHandlersOptions {
  readonly api: HandlerAPI;
  /** Absent when `clientAccess` is `"public"`. */
  readonly clientPolicy?: ClientRoutePolicy;
  readonly downloadStorageObject?: (
    token: string,
    signature: string,
  ) => Promise<Response | null>;
  /** The plugins' endpoints; an Insights route none serves answers that Insights is off. */
  readonly endpoints?: readonly MountedEndpoint[];
}

export function createHotUpdaterHandlers({
  api,
  clientPolicy,
  downloadStorageObject,
  endpoints = [],
}: HotUpdaterHandlersOptions): HotUpdaterHandlers {
  const routeHandlers: Record<string, RouteHandler> = {
    ...createVersionRouteHandlers(),
    ...createReleaseCatalogRouteHandlers(),
    ...createAdminRouteHandlers(),
    ...Object.fromEntries(
      INSIGHTS_ROUTES.map(({ handler }) => [handler, insightsDisabled]),
    ),
    ...(downloadStorageObject === undefined
      ? {}
      : {
          downloadStorageObject: createDownloadStorageRouteHandler(
            downloadStorageObject,
          ),
        }),
  };

  const routes: HotUpdaterRoute[] = [];
  const shapes = new Map<string, string>();
  const mount =
    (router: ReturnType<typeof createRouter<string>>, admin: boolean) =>
    (method: string, path: string, handler: string): void => {
      const shape = `${admin ? "admin" : "client"} ${method} ${path.replaceAll(/:[^/]+/gu, ":")}`;
      const taken = shapes.get(shape);
      if (taken !== undefined) {
        throw new HotUpdaterConfigError(
          `${handler} (${method} ${path}) collides with ${taken} on handlers.${admin ? "admin" : "client"}.`,
        );
      }
      shapes.set(shape, handler);
      addRoute(router, method, path, handler);
      routes.push({
        method,
        path,
        access: admin
          ? "admin"
          : PUBLIC_CLIENT_ROUTES.has(handler)
            ? "public"
            : "client",
      });
    };
  /** The Insights routes no plugin endpoint serves, which answer that Insights is off. */
  const mountInsights = (
    access: "client" | "admin",
    add: (method: string, path: string, handler: string) => void,
  ) => {
    for (const route of INSIGHTS_ROUTES) {
      const served = endpoints.some(
        (endpoint) =>
          endpoint.access === route.access &&
          endpoint.method === route.method &&
          endpoint.path === route.path,
      );
      if (route.access === access && !served) {
        add(route.method, route.path, route.handler);
      }
    }
  };
  const clientRouter = createRouter<string>();
  const addClientRoute = mount(clientRouter, false);
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
    "/artifacts/v1/:targetBundleId/from/:currentBundleId",
    "artifactV1",
  );
  mountInsights("client", addClientRoute);

  const adminRouter = createRouter<string>();
  const addAdminRoute = mount(adminRouter, true);
  // The admin mount also reports the protocol, so a standalone client checks it where it calls.
  addAdminRoute("GET", "/version", "version");
  for (const route of ADMIN_ROUTES) {
    addAdminRoute(route.method, route.path, route.handler);
  }
  mountInsights("admin", addAdminRoute);
  for (const endpoint of endpoints) {
    const name = `plugin ${endpoint.plugin}: ${endpoint.method} ${endpoint.path}`;
    routeHandlers[name] = (params, request) =>
      endpoint.handler(request, params);
    (endpoint.access === "admin" ? addAdminRoute : addClientRoute)(
      endpoint.method,
      endpoint.path,
      name,
    );
  }

  const handlers = {
    client: createRequestHandler({
      api,
      ...(clientPolicy === undefined ? {} : { clientPolicy }),
      routeHandlers,
      router: clientRouter,
    }),
    admin: createRequestHandler({
      api,
      privateResponses: true,
      routeHandlers,
      router: adminRouter,
    }),
  };
  Object.defineProperty(handlers, routesOf, { value: Object.freeze(routes) });
  return Object.freeze(handlers);
}
