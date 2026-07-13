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
        where: createPrismaWhere(input.where),
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
  relationMode: PrismaRelationMode,
): DatabaseAdapterImplementation => {
  const crud = createCrudImplementation(client);
  const implementation: DatabaseAdapterImplementation = {
    ...crud,
    delete: (input) => {
      if (input.model !== "bundles" || !hasCallbackTransaction(client)) {
        return crud.delete(input);
      }
      return runPrismaTransaction(client, relationMode, (transactionClient) =>
        createCrudImplementation(transactionClient).delete(input),
      );
    },
    getUpdateInfo: createPrismaGetUpdateInfo(client),
  };
  if (!hasCallbackTransaction(client)) return implementation;
  if (relationMode === "prisma") {
    implementation.create = (input) =>
      input.model === "channels"
        ? crud.create(input)
        : runPrismaTransaction(client, relationMode, (transactionClient) =>
            createCrudImplementation(transactionClient).create(input),
          );
    implementation.update = (input) =>
      runPrismaTransaction(client, relationMode, (transactionClient) =>
        createCrudImplementation(transactionClient).update(input),
      );
  }
  return {
    ...implementation,
    transaction: (callback) =>
      runPrismaTransaction(client, relationMode, async (transactionClient) => {
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
  if (
    config.relationMode === "prisma" &&
    !hasCallbackTransaction(config.prisma)
  ) {
    throw new PrismaAdapterError(
      'relation mode "prisma" requires callback transactions',
    );
  }
  const adapter = createDatabaseAdapter({
    name: "prisma",
    adapter: () =>
      createPrismaImplementation(
        config.prisma,
        config.relationMode ?? "foreign-keys",
      ),
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
