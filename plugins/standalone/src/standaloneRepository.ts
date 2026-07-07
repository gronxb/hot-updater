import type {
  Bundle,
  BundleListQuery,
  BundlePatchListQuery,
  DatabaseBundleIdFilter,
  DatabaseBundlePatch,
  DatabasePluginCore,
  PaginatedResult,
} from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  toBundleReadModel,
  toDatabaseBundlePatches,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";

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

const MAX_REMOTE_BUNDLE_LIST_LIMIT = 100;

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

const isPaginatedResult = (value: unknown): value is PaginatedResult =>
  isRecord(value) && Array.isArray(value.data) && isRecord(value.pagination);

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

const patchMatches = (
  patch: DatabaseBundlePatch,
  where: BundlePatchListQuery["where"],
) =>
  !where ||
  ((where.id === undefined || getPatchId(patch) === where.id) &&
    (where.bundleId === undefined || patch.bundleId === where.bundleId) &&
    (where.baseBundleId === undefined ||
      patch.baseBundleId === where.baseBundleId) &&
    (where.idIn === undefined || where.idIn.includes(getPatchId(patch))) &&
    (where.bundleIdIn === undefined ||
      where.bundleIdIn.includes(patch.bundleId)) &&
    (where.baseBundleIdIn === undefined ||
      where.baseBundleIdIn.includes(patch.baseBundleId)));

const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`;

const materializePatch = (patch: DatabaseBundlePatch): DatabaseBundlePatch => ({
  ...patch,
  id: getPatchId(patch),
});

const sortPatches = (
  patches: readonly DatabaseBundlePatch[],
  orderBy: BundlePatchListQuery["orderBy"],
): DatabaseBundlePatch[] =>
  patches.slice().sort((left, right) => {
    const direction = orderBy?.direction ?? "asc";
    const field = orderBy?.field ?? "orderIndex";
    const result =
      field === "orderIndex"
        ? left.orderIndex - right.orderIndex ||
          getPatchId(left).localeCompare(getPatchId(right))
        : getPatchStringField(left, field).localeCompare(
            getPatchStringField(right, field),
          );
    return direction === "asc" ? result : -result;
  });

const getPatchStringField = (
  patch: DatabaseBundlePatch,
  field: Exclude<
    NonNullable<BundlePatchListQuery["orderBy"]>["field"],
    "orderIndex"
  >,
): string => (field === "id" ? getPatchId(patch) : patch[field]);

export const standaloneRepository = createDatabasePlugin({
  name: "standalone-repository",
  connect: (config: StandaloneRepositoryConfig): DatabasePluginCore => {
    const bundleCache = new Map<string, Bundle>();
    let bundleListTotalCache: {
      readonly key: string;
      readonly total: number;
    } | null = null;
    const getBundleListTotalCacheKey = (
      where: BundleListQuery["where"],
    ): string => JSON.stringify(where ?? null);
    const clearBundleListTotalCache = () => {
      bundleListTotalCache = null;
    };
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

    const cacheBundles = (bundles: readonly Bundle[]) => {
      for (const bundle of bundles) {
        bundleCache.set(bundle.id, bundle);
      }
    };

    const requestBundleById = async (
      bundleId: string,
    ): Promise<Bundle | null> => {
      const cachedBundle = bundleCache.get(bundleId);
      if (cachedBundle) {
        return cachedBundle;
      }

      const { path, headers: routeHeaders } = routes.retrieve(bundleId);
      const response = await fetch(buildUrl(path), {
        method: "GET",
        headers: getHeaders(routeHeaders),
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
      }

      const bundle = (await response.json()) as Bundle;
      bundleCache.set(bundle.id, bundle);
      return bundle;
    };

    const requestBundlePageFromApi = async (
      options: BundleListQuery,
      limit: number,
    ): Promise<PaginatedResult> => {
      const { where, cursor, page } = options;
      const { path, headers: routeHeaders } = routes.list();
      const url = new URL(buildUrl(path));

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

      url.searchParams.set("limit", String(limit));

      if (page !== undefined) {
        url.searchParams.set("page", String(page));
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
        cacheBundles(result.data);
        return result;
      }

      throw new Error("API Error: Invalid bundle list response");
    };

    const requestBundlePage = async (
      options: BundleListQuery,
    ): Promise<PaginatedResult> => {
      if ("offset" in options) {
        throw new Error(
          "Bundle offset pagination has been removed. Use cursor.after or cursor.before instead.",
        );
      }

      if (
        options.limit <= MAX_REMOTE_BUNDLE_LIST_LIMIT ||
        options.page !== undefined ||
        options.cursor?.before !== undefined
      ) {
        return requestBundlePageFromApi(
          options,
          Math.min(options.limit, MAX_REMOTE_BUNDLE_LIST_LIMIT),
        );
      }

      const data: Bundle[] = [];
      let after = options.cursor?.after;
      let firstPagination: PaginatedResult["pagination"] | null = null;
      let lastPagination: PaginatedResult["pagination"] | null = null;

      while (data.length < options.limit) {
        const remainingLimit = options.limit - data.length;
        const page = await requestBundlePageFromApi(
          {
            ...options,
            limit: Math.min(remainingLimit, MAX_REMOTE_BUNDLE_LIST_LIMIT),
            ...(after ? { cursor: { after } } : {}),
          },
          Math.min(remainingLimit, MAX_REMOTE_BUNDLE_LIST_LIMIT),
        );

        firstPagination ??= page.pagination;
        lastPagination = page.pagination;
        data.push(...page.data.slice(0, remainingLimit));

        if (!page.pagination.hasNextPage) {
          break;
        }

        const nextAfter = page.pagination.nextCursor ?? page.data.at(-1)?.id;
        if (!nextAfter || nextAfter === after) {
          break;
        }
        after = nextAfter;
      }

      const total = firstPagination?.total ?? data.length;
      const hasNextPage = lastPagination?.hasNextPage ?? false;
      const pagination: PaginatedResult["pagination"] = {
        total,
        hasNextPage,
        hasPreviousPage: firstPagination?.hasPreviousPage ?? false,
        currentPage: firstPagination?.currentPage ?? 1,
        totalPages: options.limit > 0 ? Math.ceil(total / options.limit) : 0,
      };
      const nextCursor = hasNextPage ? data.at(-1)?.id : undefined;
      if (nextCursor) {
        pagination.nextCursor = nextCursor;
      }
      if (firstPagination?.previousCursor != null) {
        pagination.previousCursor = firstPagination.previousCursor;
      }

      return {
        data,
        pagination,
      };
    };

    const requestBundlesByIds = async (
      bundleIds: readonly string[],
    ): Promise<Bundle[]> => {
      const found: Bundle[] = [];
      const missingIds: string[] = [];

      for (const bundleId of bundleIds) {
        const cachedBundle = bundleCache.get(bundleId);
        if (cachedBundle) {
          found.push(cachedBundle);
        } else {
          missingIds.push(bundleId);
        }
      }

      if (missingIds.length === 0) {
        return found;
      }

      const missingPage = await requestBundlePage({
        where: { id: { in: missingIds } },
        limit: Math.max(missingIds.length, 1),
      });
      return [...found, ...missingPage.data];
    };

    const requestAllBundles = async (): Promise<Bundle[]> => {
      const bundles: Bundle[] = [];
      let after: string | undefined;

      while (true) {
        const page = await requestBundlePage({
          limit: 100,
          ...(after ? { cursor: { after } } : {}),
        });
        bundles.push(...page.data);
        if (!page.pagination.hasNextPage) {
          break;
        }
        after = page.pagination.nextCursor ?? page.data.at(-1)?.id;
        if (!after) {
          break;
        }
      }

      return bundles;
    };

    const postBundle = async (bundle: Bundle) => {
      const { path, headers: routeHeaders } = routes.create();
      const response = await fetch(buildUrl(path), {
        method: "POST",
        headers: getHeaders(routeHeaders),
        body: JSON.stringify([bundle]),
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.statusText}`);
      }

      const result = (await response.json()) as { success: boolean };
      if (!result.success) {
        throw new Error("Failed to commit bundle");
      }
      clearBundleListTotalCache();
      bundleCache.set(bundle.id, bundle);
    };

    const patchBundle = async (bundleId: string, patch: Partial<Bundle>) => {
      const { path, headers: routeHeaders } = routes.update(bundleId);
      const response = await fetch(buildUrl(path), {
        method: "PATCH",
        headers: getHeaders(routeHeaders),
        body: JSON.stringify({ ...patch, id: bundleId }),
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.statusText}`);
      }

      const result = (await response.json()) as { success: boolean };
      if (!result.success) {
        throw new Error("Failed to commit bundle");
      }
      clearBundleListTotalCache();
      const current = bundleCache.get(bundleId);
      if (current) {
        bundleCache.set(bundleId, { ...current, ...patch });
      } else {
        bundleCache.delete(bundleId);
      }
    };

    const deleteBundle = async (bundleId: string) => {
      const { path, headers: routeHeaders } = routes.delete(bundleId);
      const response = await fetch(buildUrl(path), {
        method: "DELETE",
        headers: getHeaders(routeHeaders),
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Bundle with id ${bundleId} not found`);
        }
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        try {
          await response.json();
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
        }
      }
      clearBundleListTotalCache();
      bundleCache.delete(bundleId);
    };

    const patchBundlePatches = async (
      bundleId: string,
      patches: readonly DatabaseBundlePatch[],
    ) => {
      const current = await requestBundleById(bundleId);
      if (!current) {
        throw new Error("targetBundleId not found");
      }
      if (
        patches.length === 0 &&
        toDatabaseBundlePatches(current).length === 0
      ) {
        return;
      }
      await patchBundle(
        bundleId,
        toBundleReadModel(
          toDatabaseBundleRecord(current),
          patches.map(materializePatch),
        ),
      );
    };

    const requestBundlePatchById = async (
      patchId: string,
    ): Promise<DatabaseBundlePatch | null> =>
      (await requestAllBundles())
        .flatMap(toDatabaseBundlePatches)
        .map(materializePatch)
        .find((patch) => getPatchId(patch) === patchId) ?? null;

    return {
      bundles: {
        async getById({ bundleId }) {
          const bundle = await requestBundleById(bundleId);
          return bundle ? toDatabaseBundleRecord(bundle) : null;
        },
        async findMany({ where, orderBy, window }) {
          if (window.limit <= 0) {
            return [];
          }
          if (
            window.limit <= MAX_REMOTE_BUNDLE_LIST_LIMIT &&
            window.offset % window.limit === 0
          ) {
            const pageNumber = Math.floor(window.offset / window.limit) + 1;
            const page = await requestBundlePage({
              where,
              orderBy,
              limit: window.limit,
              page: pageNumber,
            });
            bundleListTotalCache = {
              key: getBundleListTotalCacheKey(where),
              total: page.pagination.total,
            };
            return page.data.map(toDatabaseBundleRecord);
          }

          const fetchLimit = window.offset + window.limit;
          const page = await requestBundlePage({
            where,
            orderBy,
            limit: fetchLimit,
          });
          bundleListTotalCache = {
            key: getBundleListTotalCacheKey(where),
            total: page.pagination.total,
          };
          return page.data
            .slice(window.offset, window.offset + window.limit)
            .map(toDatabaseBundleRecord);
        },
        async count({ where }) {
          const cacheKey = getBundleListTotalCacheKey(where);
          if (bundleListTotalCache?.key === cacheKey) {
            return bundleListTotalCache.total;
          }
          const page = await requestBundlePage({ where, limit: 1 });
          bundleListTotalCache = {
            key: cacheKey,
            total: page.pagination.total,
          };
          return page.pagination.total;
        },
        async insert({ bundle }) {
          await postBundle(bundle);
        },
        async update({ bundleId, patch }) {
          const current = await requestBundleById(bundleId);
          if (!current) {
            throw new Error("targetBundleId not found");
          }
          await patchBundle(bundleId, patch);
        },
        async delete({ bundleId }) {
          await deleteBundle(bundleId);
        },
      },
      bundlePatches: {
        async findMany({ where, orderBy, window }) {
          const bundles =
            where?.bundleId !== undefined
              ? [await requestBundleById(where.bundleId)].filter(
                  (bundle): bundle is Bundle => bundle !== null,
                )
              : where?.bundleIdIn !== undefined
                ? await requestBundlesByIds(where.bundleIdIn)
                : await requestAllBundles();
          const patches = sortPatches(
            bundles
              .flatMap(toDatabaseBundlePatches)
              .map(materializePatch)
              .filter((patch) => patchMatches(patch, where)),
            orderBy,
          );
          return patches.slice(window.offset, window.offset + window.limit);
        },
        async count({ where }) {
          const bundles =
            where?.bundleId !== undefined
              ? [await requestBundleById(where.bundleId)].filter(
                  (bundle): bundle is Bundle => bundle !== null,
                )
              : where?.bundleIdIn !== undefined
                ? await requestBundlesByIds(where.bundleIdIn)
                : await requestAllBundles();
          return bundles
            .flatMap(toDatabaseBundlePatches)
            .map(materializePatch)
            .filter((patch) => patchMatches(patch, where)).length;
        },
        getById: async ({ patchId }) => requestBundlePatchById(patchId),
        async insert({ patch }) {
          const nextPatch = materializePatch(patch);
          const current = await requestBundleById(nextPatch.bundleId);
          if (!current) {
            throw new Error("targetBundleId not found");
          }
          const patches = toDatabaseBundlePatches(current)
            .map(materializePatch)
            .filter(
              (currentPatch) => getPatchId(currentPatch) !== nextPatch.id,
            );
          await patchBundlePatches(nextPatch.bundleId, [...patches, nextPatch]);
        },
        async update({ patchId, patch }) {
          const currentPatch = await requestBundlePatchById(patchId);
          if (!currentPatch) {
            return;
          }
          const current = await requestBundleById(currentPatch.bundleId);
          if (!current) {
            return;
          }
          const nextPatch = materializePatch({
            ...currentPatch,
            ...patch,
            id: patchId,
          });
          const patches = toDatabaseBundlePatches(current)
            .map(materializePatch)
            .map((candidate) =>
              getPatchId(candidate) === patchId ? nextPatch : candidate,
            );
          await patchBundlePatches(currentPatch.bundleId, patches);
        },
        async delete({ patchId }) {
          const currentPatch = await requestBundlePatchById(patchId);
          if (!currentPatch) {
            return;
          }
          const current = await requestBundleById(currentPatch.bundleId);
          if (!current) {
            return;
          }
          const patches = toDatabaseBundlePatches(current)
            .map(materializePatch)
            .filter((patch) => getPatchId(patch) !== patchId);
          await patchBundlePatches(currentPatch.bundleId, patches);
        },
      },
    };
  },
});
