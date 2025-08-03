import type { Bundle, DatabasePluginHooks } from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";

export interface RouteConfig {
  path: string;
  headers?: Record<string, string>;
}

export interface Routes {
  upsert: () => RouteConfig;
  list: () => RouteConfig;
  retrieve: (bundleId: string) => RouteConfig;
  delete: (bundleId: string) => RouteConfig;
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
  delete: (bundleId: string) => ({
    path: `/bundles/${bundleId}`,
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
    delete: (bundleId) =>
      createRoute(
        defaultRoutes.delete(bundleId),
        config.routes?.delete?.(bundleId),
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

        const total = filteredBundles.length;
        const data = limit
          ? filteredBundles.slice(offset, offset + limit)
          : filteredBundles;

        const pagination = calculatePagination(total, { limit, offset });

        return {
          data,
          pagination,
        };
      },
      async getChannels(_): Promise<string[]> {
        const result = await this.getBundles(_, { limit: 50, offset: 0 });
        return [...new Set(result.data.map((b) => b.channel))];
      },
      async commitBundle(_, { changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        // Process each operation sequentially
        for (const op of changedSets) {
          if (op.operation === "delete") {
            // Handle delete operation
            const { path, headers: routeHeaders } = routes.delete(op.data.id);
            const response = await fetch(`${config.baseUrl}${path}`, {
              method: "DELETE",
              headers: getHeaders(routeHeaders),
            });

            if (!response.ok) {
              if (response.status === 404) {
                throw new Error(`Bundle with id ${op.data.id} not found`);
              }
              throw new Error(
                `API Error: ${response.status} ${response.statusText}`,
              );
            }

            const contentType = response.headers.get("content-type");
            if (contentType?.includes("application/json")) {
              try {
                await response.json();
              } catch (jsonError) {
                if (!response.ok) {
                  throw new Error("Failed to parse response");
                }
              }
            }
          } else if (op.operation === "insert" || op.operation === "update") {
            // Handle insert and update operations
            const { path, headers: routeHeaders } = routes.upsert();
            const response = await fetch(`${config.baseUrl}${path}`, {
              method: "POST",
              headers: getHeaders(routeHeaders),
              body: JSON.stringify([op.data]),
            });

            if (!response.ok) {
              throw new Error(`API Error: ${response.statusText}`);
            }

            const result = (await response.json()) as { success: boolean };
            if (!result.success) {
              throw new Error("Failed to commit bundle");
            }
          }
        }

        // Call hook after all operations
        hooks?.onDatabaseUpdated?.();
      },

      // Native build operations
      async getNativeBuildById(_, nativeBuildId: string) {
        return null; // Standalone implementation returns null
      },

      async getNativeBuilds(_, options) {
        return {
          data: [],
          pagination: {
            offset: 0,
            limit: options.limit,
            total: 0,
            totalPages: 0,
            currentPage: 1,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        };
      },

      async updateNativeBuild(_, targetNativeBuildId: string, newNativeBuild) {
        // Standalone implementation does nothing
      },

      async appendNativeBuild(_, insertNativeBuild) {
        // Standalone implementation does nothing
      },

      async deleteNativeBuild(_, deleteNativeBuild) {
        // Standalone implementation does nothing
      },
    },
    hooks,
  );
};
