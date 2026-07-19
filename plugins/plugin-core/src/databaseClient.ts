// allow: SIZE_OK — aggregate persistence orchestration is kept at one public seam.
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";

import { bundleToPatchRows, bundleToRow, rowsToBundles } from "./databaseRows";
import { paginateBundles } from "./paginateBundles";
import { bundleMatchesQueryWhere } from "./queryBundles";
import { resolveUpdateInfoFromBundles } from "./resolveUpdateInfoFromBundles";
import type {
  BundlePatchRow,
  BundleRow,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  DatabaseAdapter,
  DatabaseWhere,
  PaginatedResult,
  TransactionDatabaseAdapter,
} from "./types";

const PAGE_SIZE = 100;

export interface DatabaseClient<TContext = unknown> {
  getBundleById(id: string, context?: TContext): Promise<Bundle | null>;
  getUpdateInfo(
    args: GetBundlesArgs,
    context?: TContext,
  ): Promise<UpdateInfo | null>;
  getChannels(context?: TContext): Promise<string[]>;
  getBundles(
    options: DatabaseBundleQueryOptions,
    context?: TContext,
  ): Promise<PaginatedResult>;
  insertBundle(bundle: Bundle, context?: TContext): Promise<void>;
  updateBundleById(
    bundleId: string,
    update: Partial<Bundle>,
    context?: TContext,
  ): Promise<void>;
  deleteBundleById(bundleId: string, context?: TContext): Promise<void>;
  /**
   * Runs multiple aggregate mutations in one adapter transaction when
   * available. Without transaction support, operations run sequentially and
   * may leave partial state when the callback rejects.
   */
  mutate<TResult>(
    operation: (client: DatabaseMutationClient) => Promise<TResult>,
    context?: TContext,
  ): Promise<TResult>;
}

export type DatabaseMutationClient = Omit<DatabaseClient<undefined>, "mutate">;

export class DatabaseBundleNotFoundError extends Error {
  readonly name = "DatabaseBundleNotFoundError";

  constructor(readonly bundleId: string) {
    super(`Bundle "${bundleId}" was not found.`);
  }
}

const bindContext = <TContext>(
  adapter: DatabaseAdapter<TContext>,
  context: TContext | undefined,
): TransactionDatabaseAdapter => ({
  create: (input) => adapter.create(input, context),
  update: (input) => adapter.update(input, context),
  delete: (input) => adapter.delete(input, context),
  count: (input) => adapter.count(input, context),
  findOne: (input) => adapter.findOne(input, context),
  findMany: (input) => adapter.findMany(input, context),
});

const transactionAdapter = (
  database: TransactionDatabaseAdapter,
): DatabaseAdapter<undefined> => ({
  name: "transaction",
  ...database,
});

const toBundleWhere = (
  where: DatabaseBundleQueryWhere | undefined,
): readonly DatabaseWhere<"bundles">[] => {
  if (!where) return [];
  const filters: DatabaseWhere<"bundles">[] = [];
  if (where.channel !== undefined)
    filters.push({ field: "channel", value: where.channel });
  if (where.platform !== undefined)
    filters.push({ field: "platform", value: where.platform });
  if (where.enabled !== undefined)
    filters.push({ field: "enabled", value: where.enabled });
  if (where.id?.eq !== undefined)
    filters.push({ field: "id", value: where.id.eq });
  if (where.id?.gt !== undefined)
    filters.push({ field: "id", operator: "gt", value: where.id.gt });
  if (where.id?.gte !== undefined)
    filters.push({ field: "id", operator: "gte", value: where.id.gte });
  if (where.id?.lt !== undefined)
    filters.push({ field: "id", operator: "lt", value: where.id.lt });
  if (where.id?.lte !== undefined)
    filters.push({ field: "id", operator: "lte", value: where.id.lte });
  if (where.id?.in !== undefined)
    filters.push({ field: "id", operator: "in", value: where.id.in });
  if (where.targetAppVersionNotNull)
    filters.push({
      field: "target_app_version",
      operator: "ne",
      value: null,
    });
  if (where.targetAppVersion !== undefined)
    filters.push({
      field: "target_app_version",
      value: where.targetAppVersion,
    });
  if (where.targetAppVersionIn !== undefined)
    filters.push({
      field: "target_app_version",
      operator: "in",
      value: where.targetAppVersionIn,
    });
  if (where.fingerprintHash !== undefined)
    filters.push({
      field: "fingerprint_hash",
      value: where.fingerprintHash,
    });
  return filters;
};

const loadBundleRows = async (
  database: TransactionDatabaseAdapter,
  where?: readonly DatabaseWhere<"bundles">[],
): Promise<BundleRow[]> => {
  const rows: BundleRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await database.findMany({
      model: "bundles",
      where,
      limit: PAGE_SIZE,
      offset,
    });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
};

const loadPatchRows = async (
  database: TransactionDatabaseAdapter,
  ownerIds: readonly string[],
): Promise<BundlePatchRow[]> => {
  if (ownerIds.length === 0) return [];
  const rows: BundlePatchRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await database.findMany({
      model: "bundle_patches",
      where: [{ field: "bundle_id", operator: "in", value: ownerIds }],
      limit: PAGE_SIZE,
      offset,
    });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
};

const hydrateRows = async (
  database: TransactionDatabaseAdapter,
  ownerRows: readonly BundleRow[],
): Promise<Bundle[]> => {
  const patchRows = await loadPatchRows(
    database,
    ownerRows.map(({ id }) => id),
  );
  const ownerIds = new Set(ownerRows.map(({ id }) => id));
  const referencedIds = [
    ...new Set(
      patchRows
        .map(({ base_bundle_id }) => base_bundle_id)
        .filter((id) => !ownerIds.has(id)),
    ),
  ];
  const referencedRows =
    referencedIds.length === 0
      ? []
      : await loadBundleRows(database, [
          { field: "id", operator: "in", value: referencedIds },
        ]);
  return rowsToBundles(ownerRows, patchRows, referencedRows);
};

const responsePage = async (
  database: TransactionDatabaseAdapter,
  options: DatabaseBundleQueryOptions,
): Promise<PaginatedResult> => {
  const where = toBundleWhere(options.where);
  const [rows, total] = await Promise.all([
    loadBundleRows(database, where),
    database.count({ model: "bundles", where }),
  ]);
  const rawPage = paginateBundles({
    bundles: rows,
    limit: options.limit,
    ...(options.page
      ? { offset: Math.max(0, options.page - 1) * options.limit }
      : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.orderBy ? { orderBy: options.orderBy } : {}),
  });
  return {
    data: await hydrateRows(database, rawPage.data),
    pagination: { ...rawPage.pagination, total },
  };
};

export const createDatabaseClient = <TContext = unknown>(
  adapter: DatabaseAdapter<TContext>,
): DatabaseClient<TContext> => {
  const mutate = async (
    operation: (database: TransactionDatabaseAdapter) => Promise<void>,
    context: TContext | undefined,
  ): Promise<void> => {
    if (adapter.transaction) {
      await adapter.transaction(operation, context);
    } else {
      await operation(bindContext(adapter, context));
    }
    await adapter.onDatabaseUpdated?.();
  };

  const getBundleById = async (
    id: string,
    context?: TContext,
  ): Promise<Bundle | null> => {
    const database = bindContext(adapter, context);
    const row = await database.findOne({
      model: "bundles",
      where: [{ field: "id", value: id }],
    });
    if (!row) return null;
    return (await hydrateRows(database, [row]))[0] ?? null;
  };

  const getBundles = (
    options: DatabaseBundleQueryOptions,
    context?: TContext,
  ) => responsePage(bindContext(adapter, context), options);

  const mutateBatch = async <TResult>(
    operation: (client: DatabaseMutationClient) => Promise<TResult>,
    context: TContext | undefined,
  ): Promise<TResult> => {
    const run = (database: TransactionDatabaseAdapter) =>
      operation(createDatabaseClient(transactionAdapter(database)));
    const result = adapter.transaction
      ? await adapter.transaction(run, context)
      : await run(bindContext(adapter, context));
    await adapter.onDatabaseUpdated?.();
    return result;
  };

  return {
    getBundleById,
    getBundles,
    async getChannels(context) {
      if (adapter.getChannels) return adapter.getChannels(context);
      const database = bindContext(adapter, context);
      const channels = new Set<string>();
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const rows = await database.findMany({
          model: "bundles",
          select: ["channel"],
          limit: PAGE_SIZE,
          offset,
          orderBy: [
            { field: "channel", direction: "asc" },
            { field: "id", direction: "asc" },
          ],
        });
        for (const { channel } of rows) channels.add(channel);
        if (rows.length < PAGE_SIZE) return [...channels].sort();
      }
    },
    async getUpdateInfo(args, context) {
      if (adapter.getUpdateInfo) {
        return context === undefined
          ? adapter.getUpdateInfo(args)
          : adapter.getUpdateInfo(args, context);
      }
      const channel = args.channel ?? "production";
      const minBundleId = args.minBundleId ?? NIL_UUID;
      const where: DatabaseBundleQueryWhere = {
        channel,
        platform: args.platform,
        enabled: true,
        id: { gte: minBundleId },
        ...(args._updateStrategy === "fingerprint"
          ? { fingerprintHash: args.fingerprintHash }
          : { targetAppVersionNotNull: true }),
      };
      const database = bindContext(adapter, context);
      const rows = await loadBundleRows(database, toBundleWhere(where));
      const bundles = (await hydrateRows(database, rows)).filter((bundle) =>
        bundleMatchesQueryWhere(bundle, where),
      );
      return resolveUpdateInfoFromBundles({ args, bundles, context });
    },
    async insertBundle(bundle, context) {
      await mutate(async (database) => {
        await database.create({
          model: "bundles",
          data: bundleToRow(bundle),
        });
        for (const patch of bundleToPatchRows(bundle)) {
          await database.create({ model: "bundle_patches", data: patch });
        }
      }, context);
    },
    async updateBundleById(bundleId, update, context) {
      await mutate(async (database) => {
        const currentRow = await database.findOne({
          model: "bundles",
          where: [{ field: "id", value: bundleId }],
        });
        if (!currentRow) throw new DatabaseBundleNotFoundError(bundleId);
        const [current] = await hydrateRows(database, [currentRow]);
        if (!current) throw new DatabaseBundleNotFoundError(bundleId);
        const next: Bundle = { ...current, ...update, id: bundleId };
        const { id: ignoredId, ...rowUpdate } = bundleToRow(next);
        void ignoredId;
        const updated = await database.update({
          model: "bundles",
          where: [{ field: "id", value: bundleId }],
          update: rowUpdate,
        });
        if (!updated) throw new DatabaseBundleNotFoundError(bundleId);
        await database.delete({
          model: "bundle_patches",
          where: [{ field: "bundle_id", value: bundleId }],
        });
        for (const patch of bundleToPatchRows(next)) {
          await database.create({ model: "bundle_patches", data: patch });
        }
      }, context);
    },
    async deleteBundleById(bundleId, context) {
      await mutate(async (database) => {
        await database.delete({
          model: "bundles",
          where: [{ field: "id", value: bundleId }],
        });
      }, context);
    },
    mutate: mutateBatch,
  };
};
