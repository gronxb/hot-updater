import type { Bundle } from "@hot-updater/plugin-core";
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

export const standaloneRepository =
  createDatabasePlugin<StandaloneRepositoryConfig>({
    name: "standalone-repository",
    factory: (config) => {
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

      const buildUrl = (path: string) => `${config.baseUrl}${path}`;

      const getHeaders = (routeHeaders?: Record<string, string>) => ({
        "Content-Type": "application/json",
        ...config.commonHeaders,
        ...routeHeaders,
      });

      return {
        async getBundleById(bundleId: string): Promise<Bundle | null> {
          try {
            const { path, headers: routeHeaders } = routes.retrieve(bundleId);
            const response = await fetch(buildUrl(path), {
              method: "GET",
              headers: getHeaders(routeHeaders),
            });

            if (!response.ok) {
              return null;
            }

            return (await response.json()) as Bundle;
          } catch {
            return null;
          }
        },
        async getBundles(options) {
          const { where, limit, offset = 0 } = options ?? {};
          const { path, headers: routeHeaders } = routes.list();

          // Build query string for server-side filtering
          const params = new URLSearchParams();
          if (where?.channel) params.set("channel", where.channel);
          if (where?.platform) params.set("platform", where.platform);
          if (limit) params.set("limit", String(limit));
          if (offset) params.set("offset", String(offset));

          const queryString = params.toString();
          const url = queryString
            ? `${buildUrl(path)}?${queryString}`
            : buildUrl(path);

          const response = await fetch(url, {
            method: "GET",
            headers: getHeaders(routeHeaders),
          });
          if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
          }

          const result = await response.json();

          // Handle both response formats:
          // 1. New format: { data: Bundle[], pagination: { total, ... } }
          // 2. Legacy format: Bundle[]
          if (result && typeof result === "object" && "data" in result) {
            return result as {
              data: Bundle[];
              pagination: ReturnType<typeof calculatePagination>;
            };
          }

          // Legacy format: plain array
          const bundles = result as Bundle[];
          const total = bundles.length;

          return {
            data: bundles,
            pagination: calculatePagination(total, { limit, offset }),
          };
        },
        async getChannels(): Promise<string[]> {
          const result = await this.getBundles({ limit: 50, offset: 0 });
          return [...new Set(result.data.map((b: Bundle) => b.channel))];
        },
        async commitBundle({ changedSets }) {
          if (changedSets.length === 0) {
            return;
          }

          // Process each operation sequentially
          for (const op of changedSets) {
            if (op.operation === "delete") {
              // Handle delete operation
              const { path, headers: routeHeaders } = routes.delete(op.data.id);
              const response = await fetch(buildUrl(path), {
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
                } catch (_jsonError) {
                  if (!response.ok) {
                    throw new Error("Failed to parse response");
                  }
                }
              }
            } else if (op.operation === "insert" || op.operation === "update") {
              // Handle insert and update operations
              const { path, headers: routeHeaders } = routes.upsert();
              const response = await fetch(buildUrl(path), {
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
        },
      };
    },
  });
