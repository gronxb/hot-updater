import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { mergeWith } from "es-toolkit";

import { BundleUnitOfWork } from "./bundleUnitOfWork";
import { getRequestBundleUnitOfWork } from "./bundleUnitOfWorkStore";
import { calculatePagination } from "./calculatePagination";
import type {
  DatabaseAnalyticsOperations,
  type DatabaseChanges,
  DatabaseBundleCursor,
  DatabaseBundleIdFilter,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  DatabaseChanges,
  DatabasePlugin,
  DatabasePluginHooks,
  HotUpdaterContext,
  PaginationInfo,
  Paginated,
} from "./types";

export interface AbstractDatabasePlugin<TContext = unknown> {
  analytics?: DatabaseAnalyticsOperations<TContext>;
  bundles: {
    supportsCursorPagination?: boolean;
    getBundleById: (
      bundleId: string,
      context?: HotUpdaterContext<TContext>,
    ) => Promise<Bundle | null>;
    getUpdateInfo?: (
      args: GetBundlesArgs,
      context?: HotUpdaterContext<TContext>,
    ) => Promise<UpdateInfo | null>;
    getBundles: (
      options: DatabaseBundleQueryOptions & { offset?: number },
      context?: HotUpdaterContext<TContext>,
    ) => Promise<Paginated<Bundle[]>>;
  };
  commit?: (
    context: HotUpdaterContext<TContext> | undefined,
    input: { readonly changes: DatabaseChanges },
  ) => Promise<void>;
  channels: {
    getChannels: (context?: HotUpdaterContext<TContext>) => Promise<string[]>;
  };
  onUnmount?: () => Promise<void>;
}

/**
 * Database plugin methods without name
 */
type DatabasePluginMethods<TContext = unknown> = Omit<
  AbstractDatabasePlugin<TContext>,
  never
>;

/**
 * Factory function that creates database plugin methods
 */
type DatabasePluginFactory<TConfig, TContext = unknown> = (
  config: TConfig,
) => DatabasePluginMethods<TContext>;

const REPLACE_ON_UPDATE_KEYS = ["patches", "targetCohorts"] as const;
const DEFAULT_DESC_ORDER = { field: "id", direction: "desc" } as const;
class DatabasePaginationInvariantError extends Error {
  constructor() {
    super("Expected at least one bundle after a non-empty pagination query.");
    this.name = "DatabasePaginationInvariantError";
  }
}

function normalizePage(value: number | undefined): number | undefined {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return undefined;
  }

  return value;
}

function mergeBundleUpdate(baseBundle: Bundle, patch: Partial<Bundle>): Bundle {
  return mergeWith(
    { ...baseBundle },
    patch,
    (_targetValue, sourceValue, key) => {
      if (
        REPLACE_ON_UPDATE_KEYS.includes(
          key as (typeof REPLACE_ON_UPDATE_KEYS)[number],
        )
      ) {
        return sourceValue;
      }

      return undefined;
    },
  );
}

function mergeIdFilter(
  base: DatabaseBundleIdFilter | undefined,
  patch: DatabaseBundleIdFilter,
): DatabaseBundleIdFilter {
  return {
    ...base,
    ...patch,
  };
}

function mergeWhereWithIdFilter(
  where: DatabaseBundleQueryWhere | undefined,
  idFilter: DatabaseBundleIdFilter,
): DatabaseBundleQueryWhere {
  return {
    ...where,
    id: mergeIdFilter(where?.id, idFilter),
  };
}

function buildCursorPageQuery(
  where: DatabaseBundleQueryWhere | undefined,
  cursor: DatabaseBundleCursor,
  orderBy: DatabaseBundleQueryOrder,
): {
  reverseData: boolean;
  where: DatabaseBundleQueryWhere;
  orderBy: DatabaseBundleQueryOrder;
} {
  const direction = orderBy.direction;

  if (cursor.after) {
    return {
      reverseData: false,
      where: mergeWhereWithIdFilter(where, {
        [direction === "desc" ? "lt" : "gt"]: cursor.after,
      }),
      orderBy,
    };
  }

  if (cursor.before) {
    return {
      reverseData: true,
      where: mergeWhereWithIdFilter(where, {
        [direction === "desc" ? "gt" : "lt"]: cursor.before,
      }),
      orderBy: {
        field: orderBy.field,
        direction: direction === "desc" ? "asc" : "desc",
      },
    };
  }

  return {
    reverseData: false,
    where: where ?? {},
    orderBy,
  };
}

function buildCountBeforeWhere(
  where: DatabaseBundleQueryWhere | undefined,
  firstBundleId: string,
  orderBy: DatabaseBundleQueryOrder,
): DatabaseBundleQueryWhere {
  return mergeWhereWithIdFilter(where, {
    [orderBy.direction === "desc" ? "gt" : "lt"]: firstBundleId,
  });
}

function createPaginatedResult(
  total: number,
  limit: number,
  startIndex: number,
  data: Bundle[],
) {
  const pagination = calculatePagination(total, {
    limit,
    offset: startIndex,
  });
  const nextCursor =
    data.length > 0 && startIndex + data.length < total
      ? data.at(-1)?.id
      : undefined;
  const previousCursor =
    data.length > 0 && startIndex > 0 ? data[0]?.id : undefined;

  return {
    data,
    pagination: {
      ...pagination,
      ...(nextCursor ? { nextCursor } : {}),
      ...(previousCursor ? { previousCursor } : {}),
    },
  };
}

function expandLimitForUnitOfWork(
  options: DatabaseBundleQueryOptions,
  unitOfWork: BundleUnitOfWork,
): DatabaseBundleQueryOptions {
  const extraLimit = unitOfWork.listFetchExtraCount();
  if (extraLimit === 0) {
    return options;
  }

  return {
    ...options,
    limit: options.limit + extraLimit,
  };
}

function adjustPaginationTotal(
  pagination: PaginationInfo,
  options: {
    readonly limit: number;
    readonly totalDelta: number;
  },
): PaginationInfo {
  if (options.totalDelta === 0) {
    return pagination;
  }

  const total = Math.max(0, pagination.total + options.totalDelta);
  const hasPreviousPage = pagination.currentPage > 1;
  const hasNextPage = pagination.currentPage * options.limit < total;
  return {
    ...pagination,
    total,
    hasNextPage,
    hasPreviousPage,
    totalPages: total === 0 ? 0 : Math.ceil(total / options.limit),
  };
}

/**
 * Configuration options for creating a database plugin
 */
export type CreateDatabasePluginOptions<TConfig, TContext = unknown> = {
  analytics?: boolean;
  name: string;
  factory: DatabasePluginFactory<TConfig, TContext>;
};

/**
 * Creates a database plugin with lazy initialization and automatic hook execution.
 *
 * This factory function abstracts the double currying pattern used by all database plugins,
 * ensuring consistent lazy initialization behavior across different database providers.
 * Hooks are automatically executed at appropriate times without requiring manual invocation.
 *
 * @param options - Configuration options for the database plugin
 * @returns A double-curried function that lazily initializes the database plugin
 *
 * @example
 * ```typescript
 * export const postgres = createDatabasePlugin<PostgresConfig>({
 *   name: "postgres",
 *   factory: (config) => {
 *     const db = new Kysely(config);
 *     return {
 *       bundles: {
 *         async getBundleById(bundleId) { ... },
 *         async getBundles(options) { ... }
 *       },
 *       async commit({ changedSets }) { ... },
 *       channels: {
 *         async getChannels() { ... },
 *       },
 *     };
 *   },
 * });
 * ```
 */
export function createDatabasePlugin<TConfig, TContext = unknown>(
  options: CreateDatabasePluginOptions<TConfig, TContext>,
) {
  return (
    config: TConfig,
    hooks?: DatabasePluginHooks,
  ): (() => DatabasePlugin<TContext>) => {
    // Share the underlying plugin methods for a configured factory while
    // keeping each returned DatabasePlugin instance's pending changes isolated.
    let cachedMethods: DatabasePluginMethods<TContext> | null = null;
    const getMethods = () => {
      if (!cachedMethods) {
        cachedMethods = options.factory(config);
      }
      return cachedMethods;
    };

    return (): DatabasePlugin<TContext> => {
      const instanceMutationUnitOfWork = new BundleUnitOfWork();
      const getRequestUnitOfWork = (context?: HotUpdaterContext<TContext>) => {
        return getRequestBundleUnitOfWork(context);
      };
      const getMutationUnitOfWork = (context?: HotUpdaterContext<TContext>) => {
        return getRequestUnitOfWork(context) ?? instanceMutationUnitOfWork;
      };

      const runGetBundles = async (
        options: DatabaseBundleQueryOptions & { offset?: number },
        context?: HotUpdaterContext<TContext>,
      ) => {
        if (context === undefined) {
          return getMethods().bundles.getBundles(options);
        }

        return getMethods().bundles.getBundles(options, context);
      };

      const getBundlesWithLegacyCursorFallback = async (
        options: DatabaseBundleQueryOptions,
        context?: HotUpdaterContext<TContext>,
      ) => {
        const orderBy = options.orderBy ?? DEFAULT_DESC_ORDER;
        const baseWhere = options.where;
        const totalResult = await runGetBundles(
          {
            where: baseWhere,
            limit: 1,
            offset: 0,
            orderBy,
          },
          context,
        );
        const total = totalResult.pagination.total;

        if (!options.cursor?.after && !options.cursor?.before) {
          const firstPage = await runGetBundles(
            {
              where: baseWhere,
              limit: options.limit,
              offset: 0,
              orderBy,
            },
            context,
          );

          return createPaginatedResult(total, options.limit, 0, firstPage.data);
        }

        const {
          where,
          orderBy: queryOrderBy,
          reverseData,
        } = buildCursorPageQuery(baseWhere, options.cursor, orderBy);

        const cursorPage = await runGetBundles(
          {
            where,
            limit: options.limit,
            offset: 0,
            orderBy: queryOrderBy,
          },
          context,
        );
        const data = reverseData
          ? cursorPage.data.slice().reverse()
          : cursorPage.data;

        if (data.length === 0) {
          const emptyStartIndex = options.cursor.after ? total : 0;
          return {
            data,
            pagination: {
              ...calculatePagination(total, {
                limit: options.limit,
                offset: emptyStartIndex,
              }),
              ...(options.cursor.after
                ? { previousCursor: options.cursor.after }
                : {}),
              ...(options.cursor.before
                ? { nextCursor: options.cursor.before }
                : {}),
            },
          };
        }

        const firstBundle = data[0];
        if (!firstBundle) {
          throw new DatabasePaginationInvariantError();
        }
        const firstBundleId = firstBundle.id;
        const countBeforeResult = await runGetBundles(
          {
            where: buildCountBeforeWhere(baseWhere, firstBundleId, orderBy),
            limit: 1,
            offset: 0,
            orderBy,
          },
          context,
        );

        return createPaginatedResult(
          total,
          options.limit,
          countBeforeResult.pagination.total,
          data,
        );
      };

      const plugin: DatabasePlugin<TContext> = {
        name: options.name,

        async commit(context) {
          const methods = getMethods();
          const unitOfWork = getMutationUnitOfWork(context);
          const changes = { bundles: unitOfWork.changedSets() };

          if (methods.commit) {
            await methods.commit(context, { changes });
          } else {
            await methods.bundles.commitBundle?.(
              { changedSets: changes.bundles },
              context,
            );
          }

          unitOfWork.clear();
          await hooks?.onDatabaseUpdated?.();
        },

        bundles: {
          get supportsCursorPagination() {
            return getMethods().bundles.supportsCursorPagination;
          },

          async getBundleById(bundleId: string, context) {
            const requestUnitOfWork = getRequestUnitOfWork(context);
            if (requestUnitOfWork) {
              return requestUnitOfWork.getById(bundleId, () =>
                getMethods().bundles.getBundleById(bundleId, context),
              );
            }

            const pendingMutation =
              instanceMutationUnitOfWork.peekChanged(bundleId);
            if (pendingMutation.found) {
              return pendingMutation.value;
            }

            return getMethods().bundles.getBundleById(bundleId);
          },

          async getBundles(options, context) {
            if (
              typeof options === "object" &&
              options !== null &&
              "offset" in options &&
              options.offset !== undefined
            ) {
              throw new Error(
                "Bundle offset pagination has been removed. Use cursor.after or cursor.before instead.",
              );
            }

            const methods = getMethods().bundles;
            const requestUnitOfWork = getRequestUnitOfWork(context);
            const unitOfWork = requestUnitOfWork ?? instanceMutationUnitOfWork;
            const shouldOverlay =
              requestUnitOfWork !== null ||
              instanceMutationUnitOfWork.hasChanges();
            const normalizedOptions = {
              ...options,
              page: normalizePage(options.page),
              orderBy: options.orderBy ?? DEFAULT_DESC_ORDER,
            };
            const overlayResult = <TData extends Paginated<Bundle[]>>(
              result: TData,
            ): TData => ({
              ...result,
              data: unitOfWork.overlayList(result.data, {
                limit: normalizedOptions.limit,
                orderBy: normalizedOptions.orderBy,
                where: normalizedOptions.where,
              }),
              pagination: adjustPaginationTotal(result.pagination, {
                limit: normalizedOptions.limit,
                totalDelta: unitOfWork.totalDelta(normalizedOptions.where),
              }),
            });

            if (normalizedOptions.page !== undefined) {
              const { page, ...pageOptions } = normalizedOptions;
              const requestedOffset = (page - 1) * normalizedOptions.limit;
              const fetchPageOptions = expandLimitForUnitOfWork(
                pageOptions,
                unitOfWork,
              );
              let pageResult = await runGetBundles(
                {
                  ...fetchPageOptions,
                  offset: requestedOffset,
                },
                context,
              );

              const total = pageResult.pagination.total;
              const totalPages =
                total === 0 ? 0 : Math.ceil(total / normalizedOptions.limit);
              const maxOffset =
                totalPages === 0
                  ? 0
                  : (Math.max(1, totalPages) - 1) * normalizedOptions.limit;
              const resolvedOffset = Math.min(requestedOffset, maxOffset);

              if (resolvedOffset !== requestedOffset) {
                pageResult = await runGetBundles(
                  {
                    ...fetchPageOptions,
                    offset: resolvedOffset,
                  },
                  context,
                );
              }

              const result = {
                ...createPaginatedResult(
                  total,
                  normalizedOptions.limit,
                  resolvedOffset,
                  pageResult.data,
                ),
              };
              return shouldOverlay ? overlayResult(result) : result;
            }

            if (methods.supportsCursorPagination) {
              const fetchOptions = expandLimitForUnitOfWork(
                normalizedOptions,
                unitOfWork,
              );
              const result =
                context === undefined
                  ? await methods.getBundles(fetchOptions)
                  : await methods.getBundles(fetchOptions, context);
              return shouldOverlay ? overlayResult(result) : result;
            }

            const result = await getBundlesWithLegacyCursorFallback(
              shouldOverlay
                ? expandLimitForUnitOfWork(normalizedOptions, unitOfWork)
                : normalizedOptions,
              context,
            );
            return shouldOverlay ? overlayResult(result) : result;
          },

          async updateBundle(
            targetBundleId: string,
            newBundle: Partial<Bundle>,
            context,
          ) {
            const unitOfWork = getMutationUnitOfWork(context);
            const currentBundle = await unitOfWork.getById(targetBundleId, () =>
              context === undefined
                ? getMethods().bundles.getBundleById(targetBundleId)
                : getMethods().bundles.getBundleById(targetBundleId, context),
            );
            if (!currentBundle) {
              throw new Error("targetBundleId not found");
            }

            const updatedBundle = mergeBundleUpdate(currentBundle, newBundle);
            unitOfWork.markUpdate(updatedBundle);
          },

          async appendBundle(inputBundle: Bundle, context) {
            getMutationUnitOfWork(context).markInsert(inputBundle);
          },

          async deleteBundle(deleteBundle: Bundle, context): Promise<void> {
            getMutationUnitOfWork(context).markDelete(deleteBundle);
          },
        },

        async commit(context) {
          const methods = getMethods();
          const unitOfWork = getMutationUnitOfWork(context);
          const params = {
            changedSets: unitOfWork.changedSets(),
          };

          if (context === undefined) {
            await methods.commit(params);
          } else {
            await methods.commit(params, context);
          }

          unitOfWork.clear();
          await hooks?.onDatabaseUpdated?.();
        },

        channels: {
          async getChannels(context) {
            if (context === undefined) {
              return getMethods().channels.getChannels();
            }

            return getMethods().channels.getChannels(context);
          },
        },

        async commit(context) {
          const unitOfWork = getMutationUnitOfWork(context);
          await getMethods().commit(context, {
            changes: {
              bundles: unitOfWork.changedSets(),
            },
          });

          unitOfWork.clear();
          await hooks?.onDatabaseUpdated?.();
        },

        async onUnmount() {
          const methods = getMethods();
          if (methods.onUnmount) {
            return methods.onUnmount();
          }
        },
      };

      Object.defineProperty(plugin.bundles, "getUpdateInfo", {
        configurable: true,
        enumerable: true,
        get() {
          const methods = getMethods().bundles;
          const directGetUpdateInfo = methods.getUpdateInfo;

          if (!directGetUpdateInfo) {
            Object.defineProperty(plugin.bundles, "getUpdateInfo", {
              configurable: true,
              enumerable: true,
              value: undefined,
            });
            return undefined;
          }

          const wrappedGetUpdateInfo: NonNullable<
            DatabasePlugin<TContext>["bundles"]["getUpdateInfo"]
          > = async (args, context) => {
            if (context === undefined) {
              return directGetUpdateInfo(args);
            }

            return directGetUpdateInfo(args, context);
          };

          Object.defineProperty(plugin.bundles, "getUpdateInfo", {
            configurable: true,
            enumerable: true,
            value: wrappedGetUpdateInfo,
          });
          return wrappedGetUpdateInfo;
        },
      });

      if (options.analytics === true) {
        Object.defineProperty(plugin, "analytics", {
          configurable: true,
          enumerable: true,
          get() {
            const analytics = getMethods().analytics;
            Object.defineProperty(plugin, "analytics", {
              configurable: true,
              enumerable: true,
              value: analytics,
            });
            return analytics;
          },
        });
      }

      return plugin;
    };
  };
}
