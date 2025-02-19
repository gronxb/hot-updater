export interface RouteConfig {
  path: string;
  headers?: Record<string, string>;
}

export interface Routes {
  upsert: () => RouteConfig;
  list: () => RouteConfig;
  retrieve: (bundleId: string) => RouteConfig;
}
