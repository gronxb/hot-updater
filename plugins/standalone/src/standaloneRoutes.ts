export interface RouteConfig {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Routes {
  readonly create?: () => RouteConfig;
  readonly update?: (bundleId: string) => RouteConfig;
  readonly list?: () => RouteConfig;
  readonly retrieve?: (bundleId: string) => RouteConfig;
  readonly delete?: (bundleId: string) => RouteConfig;
}

export interface StandaloneRepositoryConfig {
  /** Base URL of the Hot Updater admin handler. */
  readonly baseUrl: string;
  readonly commonHeaders?: Readonly<Record<string, string>>;
  readonly routes?: Routes;
}

function bundlePath(bundleId: string): string {
  return `/bundles/${encodeURIComponent(bundleId)}`;
}

function channelPath(channelId: string): string {
  return `/channels/${encodeURIComponent(channelId)}`;
}

export const defaultRoutes = {
  create: () => ({ path: "/bundles" }),
  update: (bundleId: string) => ({
    path: bundlePath(bundleId),
  }),
  list: () => ({
    path: "/bundles",
    headers: { "Cache-Control": "no-cache" },
  }),
  channels: () => ({
    path: "/channels",
    headers: { "Cache-Control": "no-cache" },
  }),
  deleteChannel: (channelId: string) => ({
    path: channelPath(channelId),
    headers: {},
  }),
  retrieve: (bundleId: string) => ({
    path: bundlePath(bundleId),
    headers: { Accept: "application/json" },
  }),
  delete: (bundleId: string) => ({
    path: bundlePath(bundleId),
  }),
};

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
