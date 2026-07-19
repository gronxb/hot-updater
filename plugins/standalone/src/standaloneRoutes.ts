export interface RouteConfig {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Routes {
  readonly appendEvent?: () => RouteConfig;
  readonly bundleEventAnalytics?: (bundleId: string) => RouteConfig;
  readonly bundleEventSummary?: (bundleId: string) => RouteConfig;
  readonly bundleEventOverview?: () => RouteConfig;
  readonly activeInstallationOverview?: () => RouteConfig;
  readonly create?: () => RouteConfig;
  readonly update?: (bundleId: string) => RouteConfig;
  readonly list?: () => RouteConfig;
  readonly channels?: () => RouteConfig;
  readonly installationHistory?: (installId: string) => RouteConfig;
  readonly installations?: () => RouteConfig;
  readonly retrieve?: (bundleId: string) => RouteConfig;
  readonly delete?: (bundleId: string) => RouteConfig;
}

export interface StandaloneRepositoryConfig {
  readonly baseUrl: string;
  readonly commonHeaders?: Readonly<Record<string, string>>;
  readonly routes?: Routes;
  readonly supportsAnalytics?: boolean;
}

export const defaultRoutes = {
  appendEvent: () => ({ path: "/events" }),
  bundleEventAnalytics: (bundleId: string) => ({
    path: `/api/bundles/${encodeURIComponent(bundleId)}/events/analytics`,
    headers: { "Cache-Control": "no-cache" },
  }),
  bundleEventSummary: (bundleId: string) => ({
    path: `/api/bundles/${encodeURIComponent(bundleId)}/events/summary`,
    headers: { "Cache-Control": "no-cache" },
  }),
  bundleEventOverview: () => ({
    path: "/api/installations/overview",
    headers: { "Cache-Control": "no-cache" },
  }),
  activeInstallationOverview: () => ({
    path: "/api/installations/active",
    headers: { "Cache-Control": "no-cache" },
  }),
  create: () => ({ path: "/api/bundles" }),
  update: (bundleId: string) => ({ path: `/api/bundles/${bundleId}` }),
  list: () => ({
    path: "/api/bundles",
    headers: { "Cache-Control": "no-cache" },
  }),
  channels: () => ({
    path: "/api/bundles/channels",
    headers: { "Cache-Control": "no-cache" },
  }),
  retrieve: (bundleId: string) => ({
    path: `/api/bundles/${bundleId}`,
    headers: { Accept: "application/json" },
  }),
  delete: (bundleId: string) => ({ path: `/api/bundles/${bundleId}` }),
  installationHistory: (installId: string) => ({
    path: `/api/installations/${encodeURIComponent(installId)}/events`,
    headers: { "Cache-Control": "no-cache" },
  }),
  installations: () => ({
    path: "/api/installations",
    headers: { "Cache-Control": "no-cache" },
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
