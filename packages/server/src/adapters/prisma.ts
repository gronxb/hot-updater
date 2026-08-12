import type { BundleRow } from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  type DatabaseImplementationResult,
  type DatabasePluginImplementation,
  type FindManyDatabaseImplementationInput,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";

import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
} from "../db/schema/registry";
import { generatePrismaSchema } from "../db/schemaGenerators";
import type {
  DatabaseAdapterWithCapabilities,
  ORMProvider,
  ORMSQLProvider,
  SchemaGenerator,
} from "../db/types";
import {
  isChannelDeleteReferencedError,
  translateChannelDeleteError,
} from "./databaseConstraintErrors";
import { hasNullOrderOverrides, sortRowsByOrder } from "./databasePluginUtils";
import { createPrismaOrderBy, createPrismaWhere } from "./prismaQuery";
import {
  getPrismaDelegate,
  parsePrismaBundleEventRow,
  parsePrismaBundleRow,
  parsePrismaChannelRow,
  parsePrismaClientAccessKeyRow,
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
  readonly provider: ORMSQLProvider;
  readonly relationMode?: PrismaRelationMode;
  readonly db?: unknown;
}

const hasCallbackTransaction = (
  client: object,
): client is PrismaTransactionClient =>
  "$transaction" in client && typeof client.$transaction === "function";

const runPrismaTransaction = <TResult>(
  client: PrismaTransactionClient,
  isolationLevel: "default" | "serializable",
  callback: (client: object) => Promise<TResult>,
): Promise<TResult> =>
  isolationLevel === "serializable"
    ? client.$transaction(callback, { isolationLevel: "Serializable" })
    : client.$transaction(callback);

const assertPrismaProvider = (provider: ORMProvider): void => {
  if (provider === "mongodb") {
    throw new PrismaAdapterError(
      "Prisma adapter does not support MongoDB; use mongodbAdapter instead",
    );
  }
};

const findMany = async (
  client: object,
  input: FindManyDatabaseImplementationInput,
  provider: ORMSQLProvider,
): Promise<readonly DatabaseImplementationResult[]> => {
  if (input.distinctOn !== undefined) {
    throw new DatabasePluginInputError("invalid-operation");
  }
  const rawOrderBy =
    "orderBy" in input && input.orderBy
      ? input.orderBy
      : "sortBy" in input && input.sortBy
        ? [input.sortBy]
        : undefined;
  const orderBy = createPrismaOrderBy(rawOrderBy);
  const shouldSortInMemory =
    rawOrderBy !== undefined && hasNullOrderOverrides(rawOrderBy);
  const rows = shouldSortInMemory
    ? sortRowsByOrder(
        (await getPrismaDelegate(client, input.model).findMany({
          where: createPrismaWhere(input.where, provider),
        })) as Record<string, unknown>[],
        rawOrderBy,
      ).slice(input.offset, input.offset + input.limit)
    : await getPrismaDelegate(client, input.model).findMany({
        where: createPrismaWhere(input.where, provider),
        ...(orderBy ? { orderBy } : {}),
        skip: input.offset,
        take: input.limit,
      });
  switch (input.model) {
    case "bundles":
      return parsePrismaRows(rows, parsePrismaBundleRow);
    case "bundle_patches":
      return parsePrismaRows(rows, parsePrismaPatchRow);
    case "bundle_events":
      return parsePrismaRows(rows, parsePrismaBundleEventRow);
    case "channels":
      return parsePrismaRows(rows, parsePrismaChannelRow);
    case "client_access_keys":
      return parsePrismaRows(rows, parsePrismaClientAccessKeyRow);
  }
};

const assertBundleChannel = async (
  client: object,
  bundle: Pick<BundleRow, "channel" | "channel_id">,
): Promise<void> => {
  const channel = await getPrismaDelegate(client, "channels").findFirst({
    where: { id: bundle.channel_id, name: bundle.channel },
  });
  if (channel === null) {
    throw new PrismaAdapterError(
      "bundle references a missing or mismatched channel",
    );
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
  provider: ORMSQLProvider,
  relationMode: PrismaRelationMode,
): TransactionDatabasePluginImplementation &
  Pick<DatabasePluginImplementation, "deleteChannel" | "insertChannel"> => ({
  deleteChannel: async ({ id }) => {
    const channels = getPrismaDelegate(client, "channels");
    const existing = await channels.findFirst({ where: { id } });
    if (existing === null) return { deleted: false, reason: "not_found" };
    const referenced = await getPrismaDelegate(client, "bundles").count({
      where: { channel_id: id },
    });
    if (referenced > 0) return { deleted: false, reason: "not_empty" };
    try {
      await channels.deleteMany({ where: { id } });
    } catch (error) {
      if (isChannelDeleteReferencedError(error)) {
        return { deleted: false, reason: "not_empty" };
      }
      throw error;
    }
    return { deleted: true };
  },
  insertChannel: async (input) => {
    const delegate = getPrismaDelegate(client, "channels");
    const existing = await delegate.findFirst({
      where: { name: input.row.name },
    });
    if (existing !== null) {
      return { row: parsePrismaChannelRow(existing), inserted: false };
    }
    const row = parsePrismaChannelRow(
      await delegate.upsert({
        where: { name: input.row.name },
        create: input.row,
        update: {},
      }),
    );
    return { row, inserted: row.id === input.row.id };
  },
  create: async (input) => {
    if (input.model === "bundles") {
      assertBundleTarget(input.data);
      await assertBundleChannel(client, input.data);
    }
    if (input.model === "bundle_patches") {
      await assertPatchReferences(
        client,
        input.data.bundle_id,
        input.data.base_bundle_id,
      );
    }
    const delegate = getPrismaDelegate(client, input.model);
    let row: unknown;
    if (input.onConflict === "ignore") {
      const where =
        input.model === "channels"
          ? { name: input.data.name }
          : { hash: input.data.hash };
      row = await delegate.upsert({
        where,
        create: input.data,
        update: {},
      });
    } else {
      row = await delegate.create({ data: input.data });
    }
    switch (input.model) {
      case "bundles":
        return parsePrismaBundleRow(row);
      case "bundle_patches":
        return parsePrismaPatchRow(row);
      case "bundle_events":
        return parsePrismaBundleEventRow(row);
      case "channels":
        return parsePrismaChannelRow(row);
      case "client_access_keys":
        return parsePrismaClientAccessKeyRow(row);
    }
  },
  update: async (input) => {
    const id = input.where[0]?.value;
    if (typeof id !== "string") {
      throw new PrismaAdapterError(
        `${input.model} update requires a string id`,
      );
    }
    if (input.model === "client_access_keys") {
      const delegate = getPrismaDelegate(client, "client_access_keys");
      const current = await delegate.findFirst({ where: { id } });
      if (current === null) return null;
      await delegate.update({ where: { id }, data: input.update });
      const stored = await delegate.findFirst({ where: { id } });
      return stored === null ? null : parsePrismaClientAccessKeyRow(stored);
    }
    const delegate = getPrismaDelegate(client, "bundles");
    if (delegate.updateMany === undefined) {
      throw new PrismaAdapterError(
        'model delegate "bundles" requires updateMany',
      );
    }
    const current = await delegate.findFirst({ where: { id } });
    if (current === null) return null;
    const currentBundle = parsePrismaBundleRow(current);
    await assertBundleChannel(client, { ...currentBundle, ...input.update });
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
    if (input.model === "bundles" && relationMode === "prisma") {
      const rows = await getPrismaDelegate(client, "bundles").findMany({
        where: createPrismaWhere(input.where, provider),
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
    try {
      await getPrismaDelegate(client, input.model).deleteMany({
        where: createPrismaWhere(input.where, provider),
      });
    } catch (error) {
      if (input.model === "channels") {
        translateChannelDeleteError(error);
      }
      throw error;
    }
  },
  count: async (input) => {
    if (input.distinct !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    return getPrismaDelegate(client, input.model).count({
      where: createPrismaWhere(input.where, provider),
    });
  },
  findOne: async (input) => {
    const row = await getPrismaDelegate(client, input.model).findFirst({
      where: createPrismaWhere(input.where, provider),
    });
    if (row === null) return null;
    switch (input.model) {
      case "bundles":
        return parsePrismaBundleRow(row);
      case "bundle_patches":
        return parsePrismaPatchRow(row);
      case "channels":
        return parsePrismaChannelRow(row);
      case "client_access_keys":
        return parsePrismaClientAccessKeyRow(row);
    }
  },
  findMany: (input) => findMany(client, input, provider),
});

const createPrismaImplementation = (
  client: object,
  relationMode: PrismaRelationMode,
  provider: ORMSQLProvider,
): DatabasePluginImplementation => {
  const crud = createCrudImplementation(client, provider, relationMode);
  const implementation: DatabasePluginImplementation = {
    ...crud,
    deleteChannel: (input) => {
      if (!hasCallbackTransaction(client)) {
        throw new PrismaAdapterError(
          "channel deletion requires callback transactions",
        );
      }
      return runPrismaTransaction(client, "serializable", (transactionClient) =>
        createCrudImplementation(
          transactionClient,
          provider,
          relationMode,
        ).deleteChannel(input),
      );
    },
    delete: (input) => {
      if (input.model !== "bundles" || relationMode === "foreign-keys") {
        return crud.delete(input);
      }
      if (!hasCallbackTransaction(client)) {
        throw new PrismaAdapterError(
          'relation mode "prisma" requires callback transactions',
        );
      }
      return runPrismaTransaction(client, "serializable", (transactionClient) =>
        createCrudImplementation(
          transactionClient,
          provider,
          relationMode,
        ).delete(input),
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
      runPrismaTransaction(client, "serializable", (transactionClient) =>
        createCrudImplementation(
          transactionClient,
          provider,
          relationMode,
        ).create(input),
      );
  }
  implementation.update = (input) =>
    runPrismaTransaction(
      client,
      relationMode === "prisma" ||
        (input.model === "bundles" &&
          provider === "postgresql" &&
          (input.update.target_app_version !== undefined ||
            input.update.fingerprint_hash !== undefined))
        ? "serializable"
        : "default",
      (transactionClient) =>
        createCrudImplementation(
          transactionClient,
          provider,
          relationMode,
        ).update(input),
    );
  return {
    ...implementation,
    transaction: (callback) =>
      runPrismaTransaction(
        client,
        relationMode === "prisma" ? "serializable" : "default",
        async (transactionClient) => {
          return callback(
            createCrudImplementation(transactionClient, provider, relationMode),
          );
        },
      ),
  };
};

export const prismaAdapter = (
  config: PrismaConfig,
): DatabaseAdapterWithCapabilities => {
  assertPrismaProvider(config.provider);
  const adapter = createDatabasePluginAdapter(
    "prisma",
    createPrismaImplementation(
      config.prisma,
      config.relationMode ?? "foreign-keys",
      config.provider,
    ),
  );
  return Object.assign(
    createDatabasePlugin({
      name: "prisma",
      models: adapter.models,
      queries: adapter.queries,
      commit: adapter.commit,
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
};
