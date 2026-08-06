export interface RouteConfig {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Routes {
  readonly create?: () => RouteConfig;
  readonly update?: (bundleId: string) => RouteConfig;
  readonly list?: () => RouteConfig;
  readonly channels?: () => RouteConfig;
  readonly retrieve?: (bundleId: string) => RouteConfig;
  readonly delete?: (bundleId: string) => RouteConfig;
}

export interface StandaloneRepositoryConfig {
  readonly baseUrl: string;
  readonly commonHeaders?: Readonly<Record<string, string>>;
  readonly routes?: Routes;
}

function bundlePath(bundleId: string): string {
  return `/api/bundles/${encodeURIComponent(bundleId)}`;
}

export const defaultRoutes = {
  create: () => ({ path: "/api/bundles" }),
  update: (bundleId: string) => ({
    path: bundlePath(bundleId),
  }),
  list: () => ({
    path: "/api/bundles",
    headers: { "Cache-Control": "no-cache" },
  }),
  channels: () => ({
    path: "/api/bundles/channels",
    headers: { "Cache-Control": "no-cache" },
  }),
  retrieve: (bundleId: string) => ({
    path: bundlePath(bundleId),
    headers: { Accept: "application/json" },
  }),
  delete: (bundleId: string) => ({
    path: bundlePath(bundleId),
  }),
};

export const appendPathSegment = (path: string, segment: string): string =>
  `${path.replace(/\/+$/, "")}/${segment}`;

export const createRoute = (
  defaultRoute: RouteConfig,
  customRoute?: RouteConfig,
): RouteConfig => ({
  path: customRoute?.path ?? defaultRoute.path,
  headers: {
    ...defaultRoute.headers,
    ...customRoute?.headers,
  },
});
