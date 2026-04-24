import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { mergeWith } from "es-toolkit";

import { calculatePagination } from "./calculatePagination";
import type {
  DatabaseBundleCursor,
  DatabaseBundleIdFilter,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  DatabasePlugin,
  DatabasePluginHooks,
  HotUpdaterContext,
  Paginated,
} from "./types";

export interface AbstractDatabasePlugin<TContext = unknown> {
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
  getChannels: (context?: HotUpdaterContext<TContext>) => Promise<string[]>;
  onUnmount?: () => Promise<void>;
  commitBundle: (
    params: {
      changedSets: {
        operation: "insert" | "update" | "delete";
        data: Bundle;
      }[];
    },
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
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

function normalizePage(value: number | undefined): number | undefined {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return undefined;
  }

  return value;
}

function mergeBundleUpdate(baseBundle: Bundle, patch: Partial<Bundle>): Bundle {
  return mergeWith(baseBundle, patch, (_targetValue, sourceValue, key) => {
    if (
      REPLACE_ON_UPDATE_KEYS.includes(
        key as (typeof REPLACE_ON_UPDATE_KEYS)[number],
      )
    ) {
      return sourceValue;
    }

    return undefined;
  });
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

/**
 * Configuration options for creating a database plugin
 */
export interface CreateDatabasePluginOptions<TConfig, TContext = unknown> {
  /**
   * The name of the database plugin (e.g., "postgres", "d1Database")
   */
  name: string;
  /**
   * Function that creates the database plugin methods
   */
  factory: DatabasePluginFactory<TConfig, TContext>;
}

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
 *       async getBundleById(bundleId) { ... },
 *       async getBundles(options) { ... },
 *       async getChannels() { ... },
 *       async commitBundle({ changedSets }) { ... }
 *     };
 *   }
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
      const changedMap = new Map<
        string,
        {
          operation: "insert" | "update" | "delete";
          data: Bundle;
        }
      >();

      const markChanged = (
        operation: "insert" | "update" | "delete",
        data: Bundle,
      ) => {
        changedMap.set(data.id, { operation, data });
      };

      const runGetBundles = async (
        options: DatabaseBundleQueryOptions & { offset?: number },
        context?: HotUpdaterContext<TContext>,
      ) => {
        if (context === undefined) {
          return getMethods().getBundles(options);
        }

        return getMethods().getBundles(options, context);
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

        const firstBundleId = data[0]!.id;
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

        async getBundleById(bundleId: string, context) {
          if (context === undefined) {
            return getMethods().getBundleById(bundleId);
          }

          return getMethods().getBundleById(bundleId, context);
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

          const methods = getMethods();
          const normalizedOptions = {
            ...options,
            page: normalizePage(options.page),
            orderBy: options.orderBy ?? DEFAULT_DESC_ORDER,
          };

          if (normalizedOptions.page !== undefined) {
            const { page, ...pageOptions } = normalizedOptions;
            const requestedOffset = (page - 1) * normalizedOptions.limit;
            let pageResult = await runGetBundles(
              {
                ...pageOptions,
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
                  ...pageOptions,
                  offset: resolvedOffset,
                },
                context,
              );
            }

            return createPaginatedResult(
              total,
              normalizedOptions.limit,
              resolvedOffset,
              pageResult.data,
            );
          }

          if (methods.supportsCursorPagination) {
            if (context === undefined) {
              return methods.getBundles(normalizedOptions);
            }

            return methods.getBundles(normalizedOptions, context);
          }

          return getBundlesWithLegacyCursorFallback(normalizedOptions, context);
        },

        async getChannels(context) {
          if (context === undefined) {
            return getMethods().getChannels();
          }

          return getMethods().getChannels(context);
        },

        async onUnmount() {
          const methods = getMethods();
          if (methods.onUnmount) {
            return methods.onUnmount();
          }
        },

        async commitBundle(context) {
          const methods = getMethods();
          const params = {
            changedSets: Array.from(changedMap.values()),
          };

          if (context === undefined) {
            await methods.commitBundle(params);
          } else {
            await methods.commitBundle(params, context);
          }

          changedMap.clear();
          await hooks?.onDatabaseUpdated?.();
        },

        async updateBundle(
          targetBundleId: string,
          newBundle: Partial<Bundle>,
          context,
        ) {
          const pendingChange = changedMap.get(targetBundleId);
          if (pendingChange) {
            const updatedData = mergeBundleUpdate(
              pendingChange.data,
              newBundle,
            );
            changedMap.set(targetBundleId, {
              operation: pendingChange.operation,
              data: updatedData,
            });
            return;
          }

          const currentBundle =
            context === undefined
              ? await getMethods().getBundleById(targetBundleId)
              : await getMethods().getBundleById(targetBundleId, context);
          if (!currentBundle) {
            throw new Error("targetBundleId not found");
          }

          const updatedBundle = mergeBundleUpdate(currentBundle, newBundle);
          markChanged("update", updatedBundle);
        },

        async appendBundle(inputBundle: Bundle) {
          markChanged("insert", inputBundle);
        },

        async deleteBundle(deleteBundle: Bundle): Promise<void> {
          markChanged("delete", deleteBundle);
        },
      };

      Object.defineProperty(plugin, "getUpdateInfo", {
        configurable: true,
        enumerable: true,
        get() {
          const methods = getMethods();
          const directGetUpdateInfo = methods.getUpdateInfo;

          if (!directGetUpdateInfo) {
            Object.defineProperty(plugin, "getUpdateInfo", {
              configurable: true,
              enumerable: true,
              value: undefined,
            });
            return undefined;
          }

          const wrappedGetUpdateInfo: NonNullable<
            DatabasePlugin<TContext>["getUpdateInfo"]
          > = async (args, context) => {
            if (context === undefined) {
              return directGetUpdateInfo(args);
            }

            return directGetUpdateInfo(args, context);
          };

          Object.defineProperty(plugin, "getUpdateInfo", {
            configurable: true,
            enumerable: true,
            value: wrappedGetUpdateInfo,
          });
          return wrappedGetUpdateInfo;
        },
      });

      return plugin;
    };
  };
}
