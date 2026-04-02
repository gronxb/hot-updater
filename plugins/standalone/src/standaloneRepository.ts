import type {
  Bundle,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";

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

const bundleMatchesQueryWhere = (
  bundle: Bundle,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  if (!where) return true;
  if (where.channel !== undefined && bundle.channel !== where.channel)
    return false;
  if (where.platform !== undefined && bundle.platform !== where.platform)
    return false;
  if (where.enabled !== undefined && bundle.enabled !== where.enabled)
    return false;
  if (where.id?.eq !== undefined && bundle.id !== where.id.eq) return false;
  if (where.id?.gt !== undefined && bundle.id.localeCompare(where.id.gt) <= 0)
    return false;
  if (where.id?.gte !== undefined && bundle.id.localeCompare(where.id.gte) < 0)
    return false;
  if (where.id?.lt !== undefined && bundle.id.localeCompare(where.id.lt) >= 0)
    return false;
  if (where.id?.lte !== undefined && bundle.id.localeCompare(where.id.lte) > 0)
    return false;
  if (where.id?.in && !where.id.in.includes(bundle.id)) return false;
  if (where.targetAppVersionNotNull && bundle.targetAppVersion === null) {
    return false;
  }
  if (
    where.targetAppVersion !== undefined &&
    bundle.targetAppVersion !== where.targetAppVersion
  ) {
    return false;
  }
  if (
    where.targetAppVersionIn &&
    !where.targetAppVersionIn.includes(bundle.targetAppVersion ?? "")
  ) {
    return false;
  }
  if (
    where.fingerprintHash !== undefined &&
    bundle.fingerprintHash !== where.fingerprintHash
  ) {
    return false;
  }
  return true;
};

const sortBundles = (
  bundles: Bundle[],
  orderBy: DatabaseBundleQueryOrder | undefined,
) => {
  if (!orderBy) {
    return bundles;
  }

  const direction = orderBy?.direction ?? "desc";
  return bundles.slice().sort((a, b) => {
    const result = a.id.localeCompare(b.id);
    return direction === "asc" ? result : -result;
  });
};

export const standaloneRepository =
  createDatabasePlugin<StandaloneRepositoryConfig>({
    name: "standalone-repository",
    factory: (config) => {
      const legacyUpsertRoute = config.routes?.upsert;
      const routes = {
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
        list: () => createRoute(defaultRoutes.list(), config.routes?.list?.()),
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
          const { where, limit, offset = 0, orderBy } = options ?? {};
          const { path, headers: routeHeaders } = routes.list();
          const response = await fetch(buildUrl(path), {
            method: "GET",
            headers: getHeaders(routeHeaders),
          });
          if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
          }
          const bundles = (await response.json()) as Bundle[];

          const filteredBundles = sortBundles(
            bundles.filter((bundle) => bundleMatchesQueryWhere(bundle, where)),
            orderBy,
          );

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
        async getChannels(): Promise<string[]> {
          const { path, headers: routeHeaders } = routes.list();

          const response = await fetch(buildUrl(path), {
            method: "GET",
            headers: getHeaders(routeHeaders),
          });

          if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
          }

          const bundles = (await response.json()) as Bundle[];
          const channels = bundles.map((b) => b.channel);
          return [...new Set(channels)];
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
