import type {
  BundleRow,
  DatabaseImplementationResult,
  DatabaseAdapterImplementation,
  FindManyDatabaseImplementationInput,
  TransactionDatabaseAdapterImplementation,
} from "@hot-updater/plugin-core";
import { createDatabaseAdapter } from "@hot-updater/plugin-core";

import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
} from "../db/schema/registry";
import { generatePrismaSchema } from "../db/schemaGenerators";
import type {
  DatabaseAdapterWithCapabilities,
  ORMProvider,
  SchemaGenerator,
} from "../db/types";
import { hasNullOrderOverrides, sortRowsByOrder } from "./databaseAdapterUtils";
import { createPrismaOrderBy, createPrismaWhere } from "./prismaQuery";
import {
  getPrismaDelegate,
  parsePrismaBundleEventRow,
  parsePrismaBundleRow,
  parsePrismaChannelRow,
  parsePrismaPatchRow,
  parsePrismaRows,
  PrismaAdapterError,
} from "./prismaRows";
import { createPrismaGetUpdateInfo } from "./prismaUpdateInfo";

type PrismaRelationMode = "prisma" | "foreign-keys";

type PrismaTransactionOptions = {
  readonly isolationLevel: "Serializable";
};

type PrismaTransactionClient = object & {
  readonly $transaction: <TResult>(
    callback: (client: object) => Promise<TResult>,
    options?: PrismaTransactionOptions,
  ) => Promise<TResult>;
};

export interface PrismaConfig {
  readonly prisma: object;
  readonly provider: ORMProvider;
  readonly relationMode?: PrismaRelationMode;
  readonly db?: unknown;
}

const hasCallbackTransaction = (
  client: object,
): client is PrismaTransactionClient =>
  "$transaction" in client && typeof client.$transaction === "function";

const runPrismaTransaction = <TResult>(
  client: PrismaTransactionClient,
  relationMode: PrismaRelationMode,
  callback: (client: object) => Promise<TResult>,
): Promise<TResult> =>
  relationMode === "prisma"
    ? client.$transaction(callback, { isolationLevel: "Serializable" })
    : client.$transaction(callback);

const createDistinctKey = (
  row: Record<string, unknown>,
  fields: readonly string[],
): string => JSON.stringify(fields.map((field) => row[field] ?? null));

const applyDistinctOnRows = <TRow extends Record<string, unknown>>(
  rows: readonly TRow[],
  fields: readonly string[],
  offset: number,
  limit: number,
): TRow[] => {
  const seen = new Set<string>();
  const distinctRows: TRow[] = [];
  for (const row of rows) {
    const key = createDistinctKey(row, fields);
    if (seen.has(key)) continue;
    seen.add(key);
    distinctRows.push(row);
  }
  return distinctRows.slice(offset, offset + limit);
};

const countDistinctRows = (
  rows: readonly Record<string, unknown>[],
  fields: readonly string[],
): number => new Set(rows.map((row) => createDistinctKey(row, fields))).size;

const findMany = async (
  client: object,
  input: FindManyDatabaseImplementationInput,
  provider: ORMProvider,
): Promise<readonly DatabaseImplementationResult[]> => {
  const rawOrderBy =
    "orderBy" in input && input.orderBy
      ? input.orderBy
      : "sortBy" in input && input.sortBy
        ? [input.sortBy]
        : undefined;
  const orderBy = createPrismaOrderBy(rawOrderBy as never);
  const shouldSortInMemory =
    rawOrderBy !== undefined && hasNullOrderOverrides(rawOrderBy as never);
  const rows =
    input.model === "bundle_events" && "distinctOn" in input && input.distinctOn
      ? applyDistinctOnRows(
          shouldSortInMemory
            ? sortRowsByOrder(
                (await getPrismaDelegate(client, input.model).findMany({
                  where: createPrismaWhere(input.where as never, provider),
                })) as Record<string, unknown>[],
                rawOrderBy as never,
              )
            : ((await getPrismaDelegate(client, input.model).findMany({
                where: createPrismaWhere(input.where as never, provider),
                ...(orderBy ? { orderBy } : {}),
              })) as Record<string, unknown>[]),
          input.distinctOn.fields,
          input.offset,
          input.limit,
        )
      : shouldSortInMemory
        ? sortRowsByOrder(
            (await getPrismaDelegate(client, input.model).findMany({
              where: createPrismaWhere(input.where as never, provider),
            })) as Record<string, unknown>[],
            rawOrderBy as never,
          ).slice(input.offset, input.offset + input.limit)
        : await getPrismaDelegate(client, input.model).findMany({
            where: createPrismaWhere(input.where as never, provider),
            ...(orderBy ? { orderBy } : {}),
            skip: input.offset,
            take: input.limit,
          });
  switch (input.model) {
    case "bundles":
      return parsePrismaRows(rows, parsePrismaBundleRow);
    case "bundle_patches":
      return parsePrismaRows(rows, parsePrismaPatchRow);
    case "channels":
      return parsePrismaRows(rows, parsePrismaChannelRow);
    case "bundle_events":
      return parsePrismaRows(rows, parsePrismaBundleEventRow);
  }
};

const assertChannelExists = async (
  client: object,
  channelId: string,
): Promise<void> => {
  const row = await getPrismaDelegate(client, "channels").findFirst({
    where: { id: channelId },
  });
  if (row === null) {
    throw new PrismaAdapterError(`channel "${channelId}" does not exist`);
  }
};

const assertPatchReferences = async (
  client: object,
  bundleId: string,
  baseBundleId: string,
): Promise<void> => {
  const ids = Array.from(new Set([bundleId, baseBundleId]));
  const count = await getPrismaDelegate(client, "bundles").count({
    where: { id: { in: ids } },
  });
  if (count !== ids.length) {
    throw new PrismaAdapterError("patch references a missing bundle");
  }
};

const assertBundleTarget = (
  bundle: Pick<BundleRow, "fingerprint_hash" | "target_app_version">,
): void => {
  if (bundle.target_app_version === null && bundle.fingerprint_hash === null) {
    throw new PrismaAdapterError(
      "bundle requires a target app version or fingerprint hash",
    );
  }
};

const createBundleTargetUpdateWhere = (
  id: string,
  update: Readonly<Partial<BundleRow>>,
): Readonly<Record<string, unknown>> => {
  if (update.target_app_version === null && update.fingerprint_hash === null) {
    throw new PrismaAdapterError(
      "bundle requires a target app version or fingerprint hash",
    );
  }
  if (
    update.target_app_version === null &&
    update.fingerprint_hash === undefined
  ) {
    return { id, fingerprint_hash: { not: null } };
  }
  if (
    update.fingerprint_hash === null &&
    update.target_app_version === undefined
  ) {
    return { id, target_app_version: { not: null } };
  }
  return { id };
};

const createCrudImplementation = (
  client: object,
  provider: ORMProvider,
): TransactionDatabaseAdapterImplementation => ({
  create: async (input) => {
    if (input.model === "bundles") {
      assertBundleTarget(input.data);
      await assertChannelExists(client, input.data.channel_id);
    }
    if (input.model === "bundle_patches") {
      await assertPatchReferences(
        client,
        input.data.bundle_id,
        input.data.base_bundle_id,
      );
    }
    const row = await getPrismaDelegate(client, input.model).create({
      data: input.data,
    });
    switch (input.model) {
      case "bundles":
        return parsePrismaBundleRow(row);
      case "bundle_patches":
        return parsePrismaPatchRow(row);
      case "channels":
        return parsePrismaChannelRow(row);
      case "bundle_events":
        return parsePrismaBundleEventRow(row);
    }
  },
  update: async (input) => {
    const id = input.where[0]?.value;
    if (typeof id !== "string") {
      throw new PrismaAdapterError("bundle update requires a string id");
    }
    if (input.update.channel_id !== undefined) {
      await assertChannelExists(client, input.update.channel_id);
    }
    const delegate = getPrismaDelegate(client, "bundles");
    if (delegate.updateMany === undefined) {
      throw new PrismaAdapterError(
        'model delegate "bundles" requires updateMany',
      );
    }
    await delegate.updateMany({
      where: createBundleTargetUpdateWhere(id, input.update),
      data: input.update,
    });
    const stored = await delegate.findFirst({ where: { id } });
    if (stored === null) return null;
    const updated = parsePrismaBundleRow(stored);
    if (
      (input.update.target_app_version !== undefined &&
        updated.target_app_version !== input.update.target_app_version) ||
      (input.update.fingerprint_hash !== undefined &&
        updated.fingerprint_hash !== input.update.fingerprint_hash)
    ) {
      throw new PrismaAdapterError("bundle target update was not applied");
    }
    return updated;
  },
  delete: async (input) => {
    if (input.model === "bundles") {
      const rows = await getPrismaDelegate(client, "bundles").findMany({
        where: createPrismaWhere(input.where as never, provider),
      });
      const ids = parsePrismaRows(rows, parsePrismaBundleRow).map(
        ({ id }) => id,
      );
      if (ids.length === 0) return;
      await getPrismaDelegate(client, "bundle_patches").deleteMany({
        where: {
          OR: [{ bundle_id: { in: ids } }, { base_bundle_id: { in: ids } }],
        },
      });
    }
    await getPrismaDelegate(client, input.model).deleteMany({
      where: createPrismaWhere(input.where as never, provider),
    });
  },
  count: async (input) => {
    if (input.model === "bundle_events" && input.distinct) {
      const rows = (await getPrismaDelegate(client, input.model).findMany({
        where: createPrismaWhere(input.where as never, provider),
      })) as Record<string, unknown>[];
      return countDistinctRows(rows, input.distinct);
    }
    return getPrismaDelegate(client, input.model).count({
      where: createPrismaWhere(input.where as never, provider),
    });
  },
  findOne: async (input) => {
    const row = await getPrismaDelegate(client, input.model).findFirst({
      where: createPrismaWhere(input.where as never, provider),
    });
    if (row === null) return null;
    switch (input.model) {
      case "bundles":
        return parsePrismaBundleRow(row);
      case "bundle_patches":
        return parsePrismaPatchRow(row);
      case "channels":
        return parsePrismaChannelRow(row);
      case "bundle_events":
        return parsePrismaBundleEventRow(row);
    }
  },
  findMany: (input) => findMany(client, input, provider),
});

const createPrismaImplementation = (
  client: object,
  relationMode: PrismaRelationMode,
  provider: ORMProvider,
): DatabaseAdapterImplementation => {
  const crud = createCrudImplementation(client, provider);
  const implementation: DatabaseAdapterImplementation = {
    ...crud,
    delete: (input) => {
      if (input.model !== "bundles" || !hasCallbackTransaction(client)) {
        return crud.delete(input);
      }
      return runPrismaTransaction(client, relationMode, (transactionClient) =>
        createCrudImplementation(transactionClient, provider).delete(input),
      );
    },
    getUpdateInfo: createPrismaGetUpdateInfo(client),
  };
  if (relationMode === "prisma" && !hasCallbackTransaction(client)) {
    throw new PrismaAdapterError(
      'relation mode "prisma" requires callback transactions',
    );
  }
  if (!hasCallbackTransaction(client)) return implementation;
  if (relationMode === "prisma") {
    implementation.create = (input) =>
      input.model === "channels" || input.model === "bundle_events"
        ? crud.create(input)
        : runPrismaTransaction(client, relationMode, (transactionClient) =>
            createCrudImplementation(transactionClient, provider).create(input),
          );
    implementation.update = (input) =>
      runPrismaTransaction(client, relationMode, (transactionClient) =>
        createCrudImplementation(transactionClient, provider).update(input),
      );
  }
  return {
    ...implementation,
    transaction: (callback) =>
      runPrismaTransaction(client, relationMode, async (transactionClient) => {
        getPrismaDelegate(transactionClient, "bundles");
        getPrismaDelegate(transactionClient, "bundle_patches");
        getPrismaDelegate(transactionClient, "channels");
        getPrismaDelegate(transactionClient, "bundle_events");
        return callback(createCrudImplementation(transactionClient, provider));
      }),
  };
};

export const prismaAdapter = (
  config: PrismaConfig,
): DatabaseAdapterWithCapabilities =>
  Object.assign(
    createDatabaseAdapter({
      name: "prisma",
      adapter: () =>
        createPrismaImplementation(
          config.prisma,
          config.relationMode ?? "foreign-keys",
          config.provider,
        ),
    }),
    {
      adapterName: "prisma",
      provider: config.provider,
      generateSchema: ((version) => ({
        code: generatePrismaSchema(
          config.provider,
          version === "latest"
            ? hotUpdaterSchema
            : getHotUpdaterSchemaVersion(version),
        ),
        path: "./prisma/schema/hot_updater.prisma",
      })) satisfies SchemaGenerator,
    },
  );
