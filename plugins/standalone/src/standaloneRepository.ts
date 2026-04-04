import type { Bundle, PaginatedResult } from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";

export interface RouteConfig {
  path: string;
  headers?: Record<string, string>;
}

export interface Routes {
  /**
   * @deprecated Use `create` and `update`. Kept for backward compatibility.
   */
  upsert?: () => RouteConfig;
  create?: () => RouteConfig;
  update?: (bundleId: string) => RouteConfig;
  list?: () => RouteConfig;
  channels?: () => RouteConfig;
  retrieve?: (bundleId: string) => RouteConfig;
  delete?: (bundleId: string) => RouteConfig;
}

const defaultRoutes = {
  create: () => ({
    path: "/api/bundles",
  }),
  update: (bundleId: string) => ({
    path: `/api/bundles/${bundleId}`,
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
    path: `/api/bundles/${bundleId}`,
    headers: { Accept: "application/json" },
  }),
  delete: (bundleId: string) => ({
    path: `/api/bundles/${bundleId}`,
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

const appendPathSegment = (path: string, segment: string) =>
  `${path.replace(/\/+$/, "")}/${segment}`;

export const standaloneRepository =
  createDatabasePlugin<StandaloneRepositoryConfig>({
    name: "standalone-repository",
    factory: (config) => {
      const legacyUpsertRoute = config.routes?.upsert;
      const customListRoute = config.routes?.list?.();
      const routes = {
        list: () => createRoute(defaultRoutes.list(), customListRoute),
        channels: () => {
          const defaultChannelsRoute = customListRoute
            ? {
                path: appendPathSegment(customListRoute.path, "channels"),
                headers: {
                  ...defaultRoutes.channels().headers,
                  ...customListRoute.headers,
                },
              }
            : defaultRoutes.channels();

          return createRoute(defaultChannelsRoute, config.routes?.channels?.());
        },
        create: () =>
          createRoute(
            defaultRoutes.create(),
            config.routes?.create?.() ?? legacyUpsertRoute?.(),
          ),
        update: (bundleId: string) =>
          createRoute(
            defaultRoutes.update(bundleId),
            config.routes?.update?.(bundleId),
          ),
        legacyUpsert: () =>
          legacyUpsertRoute
            ? createRoute(defaultRoutes.create(), legacyUpsertRoute())
            : null,
        retrieve: (bundleId: string) =>
          createRoute(
            defaultRoutes.retrieve(bundleId),
            config.routes?.retrieve?.(bundleId),
          ),
        delete: (bundleId: string) =>
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
          const url = new URL(buildUrl(path));

          if (where?.channel !== undefined) {
            url.searchParams.set("channel", where.channel);
          }

          if (where?.platform !== undefined) {
            url.searchParams.set("platform", where.platform);
          }

          if (limit !== undefined) {
            url.searchParams.set("limit", String(limit));
          }

          url.searchParams.set("offset", String(offset));

          const response = await fetch(url.toString(), {
            method: "GET",
            headers: getHeaders(routeHeaders),
          });
          if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
          }

          return (await response.json()) as PaginatedResult;
        },
        async getChannels(): Promise<string[]> {
          const { path, headers: routeHeaders } = routes.channels();

          const response = await fetch(buildUrl(path), {
            method: "GET",
            headers: getHeaders(routeHeaders),
          });

          if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
          }

          return (await response.json()) as string[];
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
            } else if (op.operation === "insert") {
              const { path, headers: routeHeaders } = routes.create();
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
            } else if (op.operation === "update") {
              const legacyRoute =
                !config.routes?.update && routes.legacyUpsert();
              const { path, headers: routeHeaders } = legacyRoute
                ? legacyRoute
                : routes.update(op.data.id);
              const response = await fetch(buildUrl(path), {
                method: legacyRoute ? "POST" : "PATCH",
                headers: getHeaders(routeHeaders),
                body: JSON.stringify(legacyRoute ? [op.data] : op.data),
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
