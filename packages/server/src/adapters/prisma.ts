import type {
  BundleRow,
  DatabaseImplementationResult,
  DatabasePluginImplementation,
  FindManyDatabaseImplementationInput,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";

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
import { hasNullOrderOverrides, sortRowsByOrder } from "./databasePluginUtils";
import { createPrismaOrderBy, createPrismaWhere } from "./prismaQuery";
import {
  getPrismaDelegate,
  parsePrismaBundleRow,
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
): TransactionDatabasePluginImplementation => ({
  create: async (input) => {
    if (input.model === "bundles") {
      assertBundleTarget(input.data);
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
    }
  },
  update: async (input) => {
    const id = input.where[0]?.value;
    if (typeof id !== "string") {
      throw new PrismaAdapterError("bundle update requires a string id");
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
    await getPrismaDelegate(client, input.model).deleteMany({
      where: createPrismaWhere(input.where, provider),
    });
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
    getChannels: async () => {
      const rows = await getPrismaDelegate(client, "bundles").findMany({
        distinct: ["channel"],
        orderBy: { channel: "asc" },
        select: { channel: true },
      });
      return Array.from(
        new Set(
          rows.map((row) => {
            if (
              typeof row !== "object" ||
              row === null ||
              !("channel" in row) ||
              typeof row.channel !== "string"
            ) {
              throw new PrismaAdapterError('expected string field "channel"');
            }
            return row.channel;
          }),
        ),
      ).sort();
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
        (provider === "postgresql" &&
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
          getPrismaDelegate(transactionClient, "bundles");
          getPrismaDelegate(transactionClient, "bundle_patches");
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
  return Object.assign(
    createDatabasePlugin({
      name: "prisma",
      plugin: () =>
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
};
