import type {
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
import { createPrismaOrderBy, createPrismaWhere } from "./prismaQuery";
import {
  getPrismaDelegate,
  parsePrismaBundleRow,
  parsePrismaChannelRow,
  parsePrismaPatchRow,
  parsePrismaRows,
  PrismaAdapterError,
} from "./prismaRows";
import { createPrismaGetUpdateInfo } from "./prismaUpdateInfo";

type PrismaRelationMode = "prisma" | "foreign-keys";

type PrismaTransactionClient = object & {
  readonly $transaction: <TResult>(
    callback: (client: object) => Promise<TResult>,
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

const findMany = async (
  client: object,
  input: FindManyDatabaseImplementationInput,
): Promise<readonly DatabaseImplementationResult[]> => {
  const args = {
    where: createPrismaWhere(input.where),
    ...(input.sortBy ? { orderBy: createPrismaOrderBy(input.sortBy) } : {}),
    skip: input.offset,
    take: input.limit,
  };
  const rows = await getPrismaDelegate(client, input.model).findMany(args);
  switch (input.model) {
    case "bundles":
      return parsePrismaRows(rows, parsePrismaBundleRow);
    case "bundle_patches":
      return parsePrismaRows(rows, parsePrismaPatchRow);
    case "channels":
      return parsePrismaRows(rows, parsePrismaChannelRow);
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

const createCrudImplementation = (
  client: object,
): TransactionDatabaseAdapterImplementation => ({
  create: async (input) => {
    if (input.model === "bundles") {
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
    const existing = await delegate.findFirst({ where: { id } });
    if (existing === null) return null;
    return parsePrismaBundleRow(
      await delegate.update({ where: { id }, data: input.update }),
    );
  },
  delete: async (input) => {
    if (input.model === "bundles") {
      const rows = await getPrismaDelegate(client, "bundles").findMany({
        where: createPrismaWhere(input.where),
      });
      const ids = parsePrismaRows(rows, parsePrismaBundleRow).map(
        ({ id }) => id,
      );
      if (ids.length === 0) return;
      const references = await getPrismaDelegate(
        client,
        "bundle_patches",
      ).count({
        where: {
          OR: [{ bundle_id: { in: ids } }, { base_bundle_id: { in: ids } }],
        },
      });
      if (references > 0) {
        throw new PrismaAdapterError(
          "cannot delete a bundle referenced by a patch",
        );
      }
    }
    await getPrismaDelegate(client, input.model).deleteMany({
      where: createPrismaWhere(input.where),
    });
  },
  count: async (input) =>
    getPrismaDelegate(client, "bundles").count({
      where: createPrismaWhere(input.where),
    }),
  findOne: async (input) => {
    const row = await getPrismaDelegate(client, input.model).findFirst({
      where: createPrismaWhere(input.where),
    });
    if (row === null) return null;
    switch (input.model) {
      case "bundles":
        return parsePrismaBundleRow(row);
      case "channels":
        return parsePrismaChannelRow(row);
    }
  },
  findMany: (input) => findMany(client, input),
});

const createPrismaImplementation = (
  client: object,
): DatabaseAdapterImplementation => {
  const crud = createCrudImplementation(client);
  const implementation: DatabaseAdapterImplementation = {
    ...crud,
    getUpdateInfo: createPrismaGetUpdateInfo(client),
  };
  if (!hasCallbackTransaction(client)) return implementation;
  return {
    ...implementation,
    transaction: (callback) =>
      client.$transaction(async (transactionClient) => {
        getPrismaDelegate(transactionClient, "bundles");
        getPrismaDelegate(transactionClient, "bundle_patches");
        getPrismaDelegate(transactionClient, "channels");
        return callback(createCrudImplementation(transactionClient));
      }),
  };
};

export const prismaAdapter = (
  config: PrismaConfig,
): DatabaseAdapterWithCapabilities => {
  if (
    config.relationMode !== undefined &&
    config.relationMode !== "prisma" &&
    config.relationMode !== "foreign-keys"
  ) {
    throw new PrismaAdapterError(
      `unsupported relation mode "${config.relationMode}"`,
    );
  }
  const adapter = createDatabaseAdapter({
    name: "prisma",
    adapter: () => createPrismaImplementation(config.prisma),
  });
  return Object.assign(adapter, {
    adapterName: "prisma",
    provider: config.provider,
    generateSchema: (version: Parameters<SchemaGenerator>[0]) => ({
      code: generatePrismaSchema(
        config.provider,
        version === "latest"
          ? hotUpdaterSchema
          : getHotUpdaterSchemaVersion(version),
      ),
      path: "./prisma/schema/hot_updater.prisma",
    }),
  });
};
