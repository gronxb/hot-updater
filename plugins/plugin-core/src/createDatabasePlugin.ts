import type { Bundle } from "@hot-updater/core";
import { mergeWith } from "es-toolkit";

import { BundleUnitOfWork } from "./bundleUnitOfWork";
import { getRequestDatabaseUnitOfWork } from "./bundleUnitOfWorkStore";
import { calculatePagination } from "./calculatePagination";
import { DatabaseUnitOfWork } from "./databaseUnitOfWork";
import { databaseDeleteInternals } from "./deleteBundleById";
import type {
  DatabaseAnalyticsOperations,
  DatabaseBundlePatch,
  DatabaseChangeBucket,
  DatabaseBundleCursor,
  DatabaseBundleIdFilter,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryOrder,
  DatabaseBundleQueryWhere,
  DatabaseChanges,
  DatabasePlugin,
  DatabasePluginHooks,
  DatabaseUpdateInput,
  DatabaseUpdatesOperations,
  HotUpdaterContext,
  PaginationInfo,
  Paginated,
  TelemetryKeyCredential,
  TelemetryLifecyclePayload,
} from "./types";

export interface AbstractDatabasePlugin<TContext = unknown> {
  analytics?: DatabaseAnalyticsOperations<TContext>;
  supportedChangeBuckets?: readonly DatabaseChangeBucket[];
  bundles: {
    get: (
      context: HotUpdaterContext<TContext> | undefined,
      input: { readonly id: string },
    ) => Promise<Bundle | null>;
    list: (
      context: HotUpdaterContext<TContext> | undefined,
      input: DatabaseBundleQueryOptions & { offset?: number },
    ) => Promise<Paginated<Bundle[]>>;
  };
  channels: {
    getChannels: (context?: HotUpdaterContext<TContext>) => Promise<string[]>;
  };
  commit: (
    context: HotUpdaterContext<TContext> | undefined,
    input: { readonly changes: DatabaseChanges },
  ) => Promise<void>;
  onUnmount?: () => Promise<void>;
  updates?: DatabaseUpdatesOperations<TContext>;
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
const CHANGE_BUCKETS = [
  "analyticsEvents",
  "bundlePatches",
  "bundles",
  "ingestKeys",
] as const satisfies readonly DatabaseChangeBucket[];
const DEFAULT_SUPPORTED_CHANGE_BUCKETS = [
  "bundles",
] as const satisfies readonly DatabaseChangeBucket[];

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

function supportedChangeBuckets<TContext>(
  methods: DatabasePluginMethods<TContext>,
): ReadonlySet<DatabaseChangeBucket> {
  return new Set([
    ...DEFAULT_SUPPORTED_CHANGE_BUCKETS,
    ...(methods.supportedChangeBuckets ?? []),
  ]);
}

function assertSupportedChangeBuckets(
  providerName: string,
  changes: DatabaseChanges,
  supportedBuckets: ReadonlySet<DatabaseChangeBucket>,
): void {
  const unsupportedBuckets = CHANGE_BUCKETS.filter(
    (bucket) =>
      !supportedBuckets.has(bucket) && (changes[bucket]?.length ?? 0) > 0,
  );

  if (unsupportedBuckets.length === 0) {
    return;
  }

  throw new Error(
    `Database provider "${providerName}" does not support committing ${unsupportedBuckets.join(
      ", ",
    )} changes.`,
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
 *         async get(context, { id }) { ... },
 *         async list(context, input) { ... }
 *       },
 *       async commit(context, { changes }) { ... },
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
      const instanceMutationUnitOfWork = new DatabaseUnitOfWork();
      const getRequestUnitOfWork = (context?: HotUpdaterContext<TContext>) => {
        return getRequestDatabaseUnitOfWork(context);
      };
      const getMutationUnitOfWork = (context?: HotUpdaterContext<TContext>) => {
        return getRequestUnitOfWork(context) ?? instanceMutationUnitOfWork;
      };
      const methodsSupportBucket = (bucket: DatabaseChangeBucket) =>
        supportedChangeBuckets(getMethods()).has(bucket);

      const runBundleList = async (
        options: DatabaseBundleQueryOptions & { offset?: number },
        context?: HotUpdaterContext<TContext>,
      ) => {
        return getMethods().bundles.list(context, options);
      };

      const listBundlesWithCursorFallback = async (
        options: DatabaseBundleQueryOptions,
        context?: HotUpdaterContext<TContext>,
      ) => {
        const orderBy = options.orderBy ?? DEFAULT_DESC_ORDER;
        const baseWhere = options.where;
        if (!options.cursor?.after && !options.cursor?.before) {
          const firstPage = await runBundleList(
            {
              where: baseWhere,
              limit: options.limit,
              offset: 0,
              orderBy,
            },
            context,
          );

          return createPaginatedResult(
            firstPage.pagination.total,
            options.limit,
            0,
            firstPage.data,
          );
        }

        const totalResult = await runBundleList(
          {
            where: baseWhere,
            limit: 1,
            offset: 0,
            orderBy,
          },
          context,
        );
        const total = totalResult.pagination.total;

        const {
          where,
          orderBy: queryOrderBy,
          reverseData,
        } = buildCursorPageQuery(baseWhere, options.cursor, orderBy);

        const cursorPage = await runBundleList(
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
        const countBeforeResult = await runBundleList(
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

        bundles: {
          async get(context, { id }) {
            const requestUnitOfWork = getRequestUnitOfWork(context);
            if (requestUnitOfWork) {
              return requestUnitOfWork.bundles.getById(id, () =>
                getMethods().bundles.get(context, { id }),
              );
            }

            const pendingMutation =
              instanceMutationUnitOfWork.bundles.peekChanged(id);
            if (pendingMutation.found) {
              return pendingMutation.value;
            }

            return getMethods().bundles.get(undefined, { id });
          },

          async list(context, input) {
            if (
              typeof input === "object" &&
              input !== null &&
              "offset" in input &&
              input.offset !== undefined
            ) {
              throw new Error(
                "Bundle offset pagination has been removed. Use cursor.after or cursor.before instead.",
              );
            }

            const requestUnitOfWork = getRequestUnitOfWork(context);
            const databaseUnitOfWork =
              requestUnitOfWork ?? instanceMutationUnitOfWork;
            const unitOfWork = databaseUnitOfWork.bundles;
            const shouldOverlay =
              requestUnitOfWork !== null ||
              instanceMutationUnitOfWork.bundles.hasChanges();
            const normalizedOptions = {
              ...input,
              page: normalizePage(input.page),
              orderBy: input.orderBy ?? DEFAULT_DESC_ORDER,
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
              let pageResult = await runBundleList(
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
                pageResult = await runBundleList(
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

            const result = await listBundlesWithCursorFallback(
              shouldOverlay
                ? expandLimitForUnitOfWork(normalizedOptions, unitOfWork)
                : normalizedOptions,
              context,
            );
            return shouldOverlay ? overlayResult(result) : result;
          },

          async update(context, { id, data }) {
            const unitOfWork = getMutationUnitOfWork(context);
            const currentBundle = await unitOfWork.bundles.getById(id, () =>
              getMethods().bundles.get(context, { id }),
            );
            if (!currentBundle) {
              throw new Error("targetBundleId not found");
            }

            const updatedBundle = mergeBundleUpdate(currentBundle, data);
            unitOfWork.bundles.markUpdate(updatedBundle);
          },

          async append(context, input) {
            getMutationUnitOfWork(context).bundles.markInsert(input.data);
          },
        },

        channels: {
          async getChannels(context) {
            if (context === undefined) {
              return getMethods().channels.getChannels();
            }

            return getMethods().channels.getChannels(context);
          },
        },

        async commit(context, _input) {
          const unitOfWork = getMutationUnitOfWork(context);
          const methods = getMethods();
          const changes = unitOfWork.changedSets();
          assertSupportedChangeBuckets(
            options.name,
            changes,
            supportedChangeBuckets(methods),
          );
          await methods.commit(context, {
            changes,
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

      Object.defineProperty(plugin, databaseDeleteInternals, {
        configurable: false,
        enumerable: false,
        value: {
          stageBundleDelete(
            context: HotUpdaterContext<TContext> | undefined,
            bundle: Bundle,
          ) {
            getMutationUnitOfWork(context).bundles.markDelete(bundle);
          },
          stageBundlePatchDelete(
            context: HotUpdaterContext<TContext> | undefined,
            patch: DatabaseBundlePatch,
          ) {
            if (!methodsSupportBucket("bundlePatches")) {
              return;
            }
            getMutationUnitOfWork(context).bundlePatches.markDelete(patch);
          },
        },
      });

      Object.defineProperty(plugin, "bundlePatches", {
        configurable: true,
        enumerable: false,
        get() {
          const table = methodsSupportBucket("bundlePatches")
            ? {
                append: async (
                  context: HotUpdaterContext<TContext> | undefined,
                  input: { readonly data: DatabaseBundlePatch },
                ) => {
                  getMutationUnitOfWork(context).bundlePatches.markInsert(
                    input.data,
                  );
                },
              }
            : undefined;
          Object.defineProperty(plugin, "bundlePatches", {
            configurable: true,
            enumerable: table !== undefined,
            value: table,
          });
          return table;
        },
      });

      Object.defineProperty(plugin, "analyticsEvents", {
        configurable: true,
        enumerable: false,
        get() {
          const table = methodsSupportBucket("analyticsEvents")
            ? {
                append: async (
                  context: HotUpdaterContext<TContext> | undefined,
                  input: { readonly data: TelemetryLifecyclePayload },
                ) => {
                  getMutationUnitOfWork(context).analyticsEvents.markInsert(
                    input.data,
                  );
                },
              }
            : undefined;
          Object.defineProperty(plugin, "analyticsEvents", {
            configurable: true,
            enumerable: table !== undefined,
            value: table,
          });
          return table;
        },
      });

      Object.defineProperty(plugin, "ingestKeys", {
        configurable: true,
        enumerable: false,
        get() {
          const table = methodsSupportBucket("ingestKeys")
            ? {
                append: async (
                  context: HotUpdaterContext<TContext> | undefined,
                  input: { readonly data: TelemetryKeyCredential },
                ) => {
                  getMutationUnitOfWork(context).ingestKeys.markInsert(
                    input.data,
                  );
                },
                update: async (
                  context: HotUpdaterContext<TContext> | undefined,
                  input: DatabaseUpdateInput<
                    string,
                    Partial<TelemetryKeyCredential>
                  >,
                ) => {
                  getMutationUnitOfWork(context).ingestKeys.markUpdate(input);
                },
              }
            : undefined;
          Object.defineProperty(plugin, "ingestKeys", {
            configurable: true,
            enumerable: table !== undefined,
            value: table,
          });
          return table;
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

      Object.defineProperty(plugin, "updates", {
        configurable: true,
        enumerable: true,
        get() {
          const updates = getMethods().updates;

          Object.defineProperty(plugin, "updates", {
            configurable: true,
            enumerable: true,
            value: updates,
          });
          return updates;
        },
      });

      return plugin;
    };
  };
}
