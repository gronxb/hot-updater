export interface RouteConfig {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Routes<TContext = unknown> {
  readonly appendEvent?: (context?: TContext) => RouteConfig;
  readonly bundleEventAnalytics?: (
    bundleId: string,
    context?: TContext,
  ) => RouteConfig;
  readonly bundleEventSummary?: (
    bundleId: string,
    context?: TContext,
  ) => RouteConfig;
  readonly bundleEventOverview?: (context?: TContext) => RouteConfig;
  readonly activeInstallationOverview?: (context?: TContext) => RouteConfig;
  readonly create?: () => RouteConfig;
  readonly update?: (bundleId: string) => RouteConfig;
  readonly list?: () => RouteConfig;
  readonly channels?: () => RouteConfig;
  readonly installationHistory?: (
    installId: string,
    context?: TContext,
  ) => RouteConfig;
  readonly installations?: (context?: TContext) => RouteConfig;
  readonly retrieve?: (bundleId: string) => RouteConfig;
  readonly delete?: (bundleId: string) => RouteConfig;
}

export interface StandaloneRepositoryConfig<TContext = unknown> {
  readonly baseUrl: string;
  readonly commonHeaders?: Readonly<Record<string, string>>;
  readonly routes?: Routes<TContext>;
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
