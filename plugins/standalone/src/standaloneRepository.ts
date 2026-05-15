import type {
  Bundle,
  DatabaseBundleIdFilter,
  PaginatedResult,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";

export interface RouteConfig {
  path: string;
  headers?: Record<string, string>;
}

export interface Routes {
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isPaginatedResult = (value: unknown): value is PaginatedResult =>
  isRecord(value) && Array.isArray(value.data) && isRecord(value.pagination);

const hasDataChannels = (
  value: unknown,
): value is {
  data: {
    channels: string[];
  };
} =>
  isRecord(value) && isRecord(value.data) && isStringArray(value.data.channels);

const setBooleanSearchParam = (
  url: URL,
  key: string,
  value: boolean | undefined,
) => {
  if (value !== undefined) {
    url.searchParams.set(key, String(value));
  }
};

const setNullableStringSearchParam = (
  url: URL,
  key: string,
  value: string | null | undefined,
) => {
  if (value !== undefined) {
    url.searchParams.set(key, value === null ? "null" : value);
  }
};

const appendStringArraySearchParams = (
  url: URL,
  key: string,
  values: string[] | undefined,
) => {
  for (const value of values ?? []) {
    url.searchParams.append(key, value);
  }
};

const setBundleIdFilterSearchParams = (
  url: URL,
  filter: DatabaseBundleIdFilter | undefined,
) => {
  if (!filter) {
    return;
  }

  if (filter.eq !== undefined) {
    url.searchParams.set("idEq", filter.eq);
  }
  if (filter.gt !== undefined) {
    url.searchParams.set("idGt", filter.gt);
  }
  if (filter.gte !== undefined) {
    url.searchParams.set("idGte", filter.gte);
  }
  if (filter.lt !== undefined) {
    url.searchParams.set("idLt", filter.lt);
  }
  if (filter.lte !== undefined) {
    url.searchParams.set("idLte", filter.lte);
  }

  appendStringArraySearchParams(url, "idIn", filter.in);
};

export const standaloneRepository =
  createDatabasePlugin<StandaloneRepositoryConfig>({
    name: "standalone-repository",
    factory: (config) => {
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
          createRoute(defaultRoutes.create(), config.routes?.create?.()),
        update: (bundleId: string) =>
          createRoute(
            defaultRoutes.update(bundleId),
            config.routes?.update?.(bundleId),
          ),
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
        supportsCursorPagination: true,
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
          const { where, limit, cursor, page } = options ?? {};
          const internalOffset =
            options &&
            typeof options === "object" &&
            "offset" in options &&
            typeof options.offset === "number"
              ? options.offset
              : undefined;
          const { path, headers: routeHeaders } = routes.list();
          const url = new URL(buildUrl(path));
          const resolvedPage =
            page ??
            (internalOffset !== undefined && limit > 0
              ? Math.floor(internalOffset / limit) + 1
              : undefined);

          if (where?.channel !== undefined) {
            url.searchParams.set("channel", where.channel);
          }

          if (where?.platform !== undefined) {
            url.searchParams.set("platform", where.platform);
          }

          setBooleanSearchParam(url, "enabled", where?.enabled);
          setBundleIdFilterSearchParams(url, where?.id);
          setNullableStringSearchParam(
            url,
            "targetAppVersion",
            where?.targetAppVersion,
          );
          appendStringArraySearchParams(
            url,
            "targetAppVersionIn",
            where?.targetAppVersionIn,
          );
          setBooleanSearchParam(
            url,
            "targetAppVersionNotNull",
            where?.targetAppVersionNotNull,
          );
          setNullableStringSearchParam(
            url,
            "fingerprintHash",
            where?.fingerprintHash,
          );

          if (limit !== undefined) {
            url.searchParams.set("limit", String(limit));
          }

          if (resolvedPage !== undefined) {
            url.searchParams.set("page", String(resolvedPage));
          }

          if (cursor?.after !== undefined) {
            url.searchParams.set("after", cursor.after);
          }

          if (cursor?.before !== undefined) {
            url.searchParams.set("before", cursor.before);
          }

          const response = await fetch(url.toString(), {
            method: "GET",
            headers: getHeaders(routeHeaders),
          });
          if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
          }

          const result = (await response.json()) as unknown;

          if (isPaginatedResult(result)) {
            return result;
          }

          throw new Error("API Error: Invalid bundle list response");
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

          const result = (await response.json()) as unknown;

          if (hasDataChannels(result)) {
            return result.data.channels;
          }

          throw new Error("API Error: Invalid channels response");
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
                } catch {
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
              const { path, headers: routeHeaders } = routes.update(op.data.id);
              const response = await fetch(buildUrl(path), {
                method: "PATCH",
                headers: getHeaders(routeHeaders),
                body: JSON.stringify(op.data),
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
