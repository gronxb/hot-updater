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
  parsePrismaReleaseCatalogRow,
  parsePrismaReleaseRow,
  parsePrismaRows,
  PrismaAdapterError,
} from "./prismaRows";

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
): Promise<TResult> => {
  const execute = () =>
    isolationLevel === "serializable"
      ? client.$transaction(callback, { isolationLevel: "Serializable" })
      : client.$transaction(callback);
  if (isolationLevel === "default") return execute();

  return (async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await execute();
      } catch (error) {
        if (
          attempt >= 2 ||
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "P2034"
        ) {
          throw error;
        }
      }
    }
  })();
};

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
  const rawOrderBy = input.orderBy;
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
    case "releases":
      return parsePrismaRows(rows, parsePrismaReleaseRow);
    case "release_catalogs":
      return parsePrismaRows(rows, parsePrismaReleaseCatalogRow);
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
    const referencedReleases = await getPrismaDelegate(
      client,
      "releases",
    ).count({ where: { channel_id: id } });
    if (referencedReleases > 0) {
      return { deleted: false, reason: "not_empty" };
    }
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
      case "releases":
        return parsePrismaReleaseRow(row);
      case "release_catalogs":
        return parsePrismaReleaseCatalogRow(row);
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
    if (input.model === "releases") {
      const delegate = getPrismaDelegate(client, "releases");
      const current = await delegate.findFirst({ where: { id } });
      if (current === null) return null;
      await delegate.update({ where: { id }, data: input.update });
      const stored = await delegate.findFirst({ where: { id } });
      return stored === null ? null : parsePrismaReleaseRow(stored);
    }
    if (input.model === "release_catalogs") {
      const delegate = getPrismaDelegate(client, "release_catalogs");
      const current = await delegate.findFirst({ where: { scope_key: id } });
      if (current === null) return null;
      await delegate.update({ where: { scope_key: id }, data: input.update });
      const stored = await delegate.findFirst({ where: { scope_key: id } });
      return stored === null ? null : parsePrismaReleaseCatalogRow(stored);
    }
    const delegate = getPrismaDelegate(client, "bundles");
    if (delegate.updateMany === undefined) {
      throw new PrismaAdapterError(
        'model delegate "bundles" requires updateMany',
      );
    }
    const current = await delegate.findFirst({ where: { id } });
    if (current === null) return null;
    await delegate.updateMany({
      where: { id },
      data: input.update,
    });
    const stored = await delegate.findFirst({ where: { id } });
    if (stored === null) return null;
    return parsePrismaBundleRow(stored);
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
      case "releases":
        return parsePrismaReleaseRow(row);
      case "release_catalogs":
        return parsePrismaReleaseCatalogRow(row);
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
      relationMode === "prisma" ? "serializable" : "default",
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
        "serializable",
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
