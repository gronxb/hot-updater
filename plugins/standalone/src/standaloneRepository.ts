import type { Bundle, DatabasePluginHooks } from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";

export interface RouteConfig {
  path: string;
  headers?: Record<string, string>;
}

export interface Routes {
  upsert: () => RouteConfig;
  list: () => RouteConfig;
  retrieve: (bundleId: string) => RouteConfig;
}

const defaultRoutes: Routes = {
  upsert: () => ({
    path: "/bundles",
  }),
  list: () => ({
    path: "/bundles",
    headers: { "Cache-Control": "no-cache" },
  }),
  retrieve: (bundleId: string) => ({
    path: `/bundles/${bundleId}`,
    headers: { Accept: "application/json" },
  }),
};

const createRoute = (
  defaultRoute: RouteConfig,
  customRoute?: Partial<RouteConfig>,
): RouteConfig => ({
  path: customRoute?.path ?? defaultRoute.path,
  headers: {
    ...defaultRoute.headers,
    ...customRoute?.headers,
  },
});

export interface StandaloneRepositoryConfig {
  baseUrl: string;
  commonHeaders?: Record<string, string>;
  routes?: Routes;
}

export const standaloneRepository = (
  config: StandaloneRepositoryConfig,
  hooks?: DatabasePluginHooks,
) => {
  const routes: Routes = {
    upsert: () =>
      createRoute(defaultRoutes.upsert(), config.routes?.upsert?.()),
    list: () => createRoute(defaultRoutes.list(), config.routes?.list?.()),
    retrieve: (bundleId) =>
      createRoute(
        defaultRoutes.retrieve(bundleId),
        config.routes?.retrieve?.(bundleId),
      ),
  };

  const getHeaders = (routeHeaders?: Record<string, string>) => ({
    "Content-Type": "application/json",
    ...config.commonHeaders,
    ...routeHeaders,
  });

  return createDatabasePlugin(
    "standalone-repository",
    {
      async getBundleById(_, bundleId: string): Promise<Bundle | null> {
        try {
          const { path, headers: routeHeaders } = routes.retrieve(bundleId);
          const response = await fetch(`${config.baseUrl}${path}`, {
            method: "GET",
            headers: getHeaders(routeHeaders),
          });

          if (!response.ok) {
            return null;
          }

          return (await response.json()) as Bundle;
        } catch (error) {
          return null;
        }
      },
      async getBundles(_, options) {
        const { where, limit, offset = 0 } = options ?? {};
        const { path, headers: routeHeaders } = routes.list();
        const response = await fetch(`${config.baseUrl}${path}`, {
          method: "GET",
          headers: getHeaders(routeHeaders),
        });

        if (!response.ok) {
          throw new Error(`API Error: ${response.statusText}`);
        }

        const bundles = (await response.json()) as Bundle[];

        let filteredBundles = bundles;
        if (where?.channel) {
          filteredBundles = filteredBundles.filter(
            (b) => b.channel === where.channel,
          );
        }
        if (where?.platform) {
          filteredBundles = filteredBundles.filter(
            (b) => b.platform === where.platform,
          );
        }

        if (limit) {
          return filteredBundles.slice(offset, offset + limit);
        }
        return filteredBundles;
      },
      async getChannels(_): Promise<string[]> {
        const allBundles = await this.getBundles(_);
        return [...new Set(allBundles.map((b) => b.channel))];
      },
      async commitBundle(_, { changedSets }) {
        const changedBundles = changedSets.map((set) => set.data);
        if (changedBundles.length === 0) {
          return;
        }

        const { path, headers: routeHeaders } = routes.upsert();
        const response = await fetch(`${config.baseUrl}${path}`, {
          method: "POST",
          headers: getHeaders(routeHeaders),
          body: JSON.stringify(changedBundles),
        });

        if (!response.ok) {
          throw new Error(`API Error: ${response.statusText}`);
        }

        const result = (await response.json()) as { success: boolean };
        if (!result.success) {
          throw new Error("Failed to commit bundles");
        }
      },
    },
    hooks,
  );
};
