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
  ChannelRow,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  DatabaseAdapter,
  DatabaseWhere,
  PaginatedResult,
  TransactionDatabaseAdapter,
} from "./types";
import { createUUIDv7 } from "./uuidv7";

const PAGE_SIZE = 100;
const transactionAdapterMarker = Symbol("transaction-adapter");

type TransactionScopedDatabaseAdapter = DatabaseAdapter<undefined> & {
  readonly [transactionAdapterMarker]: true;
};

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

class ChannelCreationConflictError extends Error {
  readonly name = "ChannelCreationConflictError";

  constructor(
    readonly channel: string,
    readonly originalError: unknown,
  ) {
    super(`Channel "${channel}" could not be created.`);
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
): TransactionScopedDatabaseAdapter => ({
  name: "transaction",
  [transactionAdapterMarker]: true,
  ...database,
});

const toBundleWhere = (
  where: DatabaseBundleQueryWhere | undefined,
  channelId?: string,
): readonly DatabaseWhere<"bundles">[] => {
  if (!where) return [];
  const filters: DatabaseWhere<"bundles">[] = [];
  if (where.channel !== undefined) {
    if (channelId === undefined) {
      filters.push({ field: "id", operator: "in", value: [] });
    } else {
      filters.push({ field: "channel_id", value: channelId });
    }
  }
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

const loadChannelRows = async (
  database: TransactionDatabaseAdapter,
  channelIds: readonly string[],
): Promise<ChannelRow[]> => {
  if (channelIds.length === 0) return [];
  const rows: ChannelRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await database.findMany({
      model: "channels",
      where: [{ field: "id", operator: "in", value: channelIds }],
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
  const channelRows = await loadChannelRows(database, [
    ...new Set(ownerRows.map(({ channel_id }) => channel_id)),
  ]);
  return rowsToBundles(ownerRows, patchRows, referencedRows, channelRows);
};

const findChannelByName = (
  database: TransactionDatabaseAdapter,
  name: string,
): Promise<ChannelRow | null> =>
  database.findOne({
    model: "channels",
    where: [{ field: "name", value: name }],
  });

const ensureChannel = async (
  database: TransactionDatabaseAdapter,
  name: string,
  transactionScoped: boolean,
): Promise<ChannelRow> => {
  const existing = await findChannelByName(database, name);
  if (existing) return existing;
  try {
    return await database.create({
      model: "channels",
      data: { id: createUUIDv7(), name },
    });
  } catch (error) {
    if (!transactionScoped) {
      const converged = await findChannelByName(database, name);
      if (converged) return converged;
    }
    throw new ChannelCreationConflictError(name, error);
  }
};

const responsePage = async (
  database: TransactionDatabaseAdapter,
  options: DatabaseBundleQueryOptions,
): Promise<PaginatedResult> => {
  const channel =
    options.where?.channel === undefined
      ? null
      : await findChannelByName(database, options.where.channel);
  const where = toBundleWhere(options.where, channel?.id);
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
  const transactionScoped =
    Reflect.get(adapter, transactionAdapterMarker) === true;
  const retryConcurrentChannelCreation = async <TResult>(
    operation: () => Promise<TResult>,
    context: TContext | undefined,
  ): Promise<TResult> => {
    try {
      return await operation();
    } catch (error) {
      if (
        transactionScoped ||
        adapter.transaction === undefined ||
        !(error instanceof ChannelCreationConflictError)
      ) {
        throw error;
      }
      const channel = await findChannelByName(
        bindContext(adapter, context),
        error.channel,
      );
      if (!channel) throw error.originalError;
      return operation();
    }
  };

  const mutate = async (
    operation: (database: TransactionDatabaseAdapter) => Promise<void>,
    context: TContext | undefined,
  ): Promise<void> => {
    const run = () =>
      adapter.transaction
        ? adapter.transaction(operation, context)
        : operation(bindContext(adapter, context));
    await retryConcurrentChannelCreation(run, context);
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
    const execute = () =>
      adapter.transaction
        ? adapter.transaction(run, context)
        : run(bindContext(adapter, context));
    const result = await retryConcurrentChannelCreation(execute, context);
    await adapter.onDatabaseUpdated?.();
    return result;
  };

  return {
    getBundleById,
    getBundles,
    async getChannels(context) {
      const database = bindContext(adapter, context);
      const channels: string[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const rows = await database.findMany({
          model: "channels",
          limit: PAGE_SIZE,
          offset,
          orderBy: [{ field: "name", direction: "asc" }],
        });
        channels.push(...rows.map(({ name }) => name));
        if (rows.length < PAGE_SIZE) return channels;
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
      const channelRow = await findChannelByName(database, channel);
      const rows = await loadBundleRows(
        database,
        toBundleWhere(where, channelRow?.id),
      );
      const bundles = (await hydrateRows(database, rows)).filter((bundle) =>
        bundleMatchesQueryWhere(bundle, where),
      );
      return resolveUpdateInfoFromBundles({ args, bundles, context });
    },
    async insertBundle(bundle, context) {
      await mutate(async (database) => {
        const channel = await ensureChannel(
          database,
          bundle.channel,
          transactionScoped || adapter.transaction !== undefined,
        );
        await database.create({
          model: "bundles",
          data: bundleToRow(bundle, channel.id),
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
        const channelId =
          next.channel === current.channel
            ? currentRow.channel_id
            : (
                await ensureChannel(
                  database,
                  next.channel,
                  transactionScoped || adapter.transaction !== undefined,
                )
              ).id;
        const { id: ignoredId, ...rowUpdate } = bundleToRow(next, channelId);
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
