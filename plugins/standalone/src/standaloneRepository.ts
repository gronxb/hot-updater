import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";

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

export const standaloneRepository =
  (config: StandaloneRepositoryConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
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

    let bundles: Bundle[] = [];
    const changedIds = new Set<string>();

    function markChanged(id: string) {
      changedIds.add(id);
    }

    return {
      name: "standalone-repository",
      async commitBundle() {
        if (changedIds.size === 0) return;

        const changedBundles = bundles.filter((b) => changedIds.has(b.id));
        if (changedBundles.length === 0) return;

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

        changedIds.clear();
        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        bundles = await this.getBundles();

        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(bundles[targetIndex], newBundle);
        markChanged(targetBundleId);
      },
      async appendBundle(inputBundle: Bundle) {
        bundles = await this.getBundles();
        bundles.unshift(inputBundle);
        markChanged(inputBundle.id);
      },
      async getBundleById(bundleId: string): Promise<Bundle | null> {
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
      async getBundles(refresh = false): Promise<Bundle[]> {
        if (bundles.length > 0 && !refresh) {
          return bundles;
        }

        const { path, headers: routeHeaders } = routes.list();
        const response = await fetch(`${config.baseUrl}${path}`, {
          method: "GET",
          headers: getHeaders(routeHeaders),
        });

        if (!response.ok) {
          throw new Error(`API Error: ${response.statusText}`);
        }

        bundles = (await response.json()) as Bundle[];
        return bundles;
      },
    };
  };
