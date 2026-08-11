import { createDatabasePluginCrud } from "./databasePluginCrud";
import { createTransactionDatabasePlugin } from "./databasePluginTransaction";
import type {
  BundlePatchRow,
  BundleRow,
  DatabaseBundleQueryWhere,
  DatabaseCommit,
  DatabaseCommitResult,
  DatabasePlugin,
  DatabasePluginCrud,
  DatabasePluginImplementation,
  DatabaseWhere,
} from "./types";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrud";

const PAGE_SIZE = 100;

export class DatabaseAtomicCommitUnsupportedError extends Error {
  readonly name = "DatabaseAtomicCommitUnsupportedError";

  constructor(readonly pluginName: string) {
    super(
      `Database plugin "${pluginName}" cannot atomically commit changes across tables.`,
    );
  }
}

export interface CreateDatabasePluginOptions {
  readonly name: string;
  readonly plugin: () => DatabasePluginImplementation;
}

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
  if (where.targetAppVersion !== undefined)
    filters.push({
      field: "target_app_version",
      value: where.targetAppVersion,
    });
  if (where.targetAppVersionNotNull)
    filters.push({
      field: "target_app_version",
      operator: "ne",
      value: null,
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

const applyChanges = async (
  database: DatabasePluginCrud,
  input: DatabaseCommit,
): Promise<DatabaseCommitResult> => {
  if (input.operation === "update") {
    const row = await database.findOne({
      model: "bundles",
      where: [{ field: "id", value: input.bundleId }],
      select: ["id"],
    });
    if (row === null) return { applied: false };
  }

  for (const change of input.changes) {
    if (change.table === "bundles") {
      switch (change.operation) {
        case "insert":
          await database.create({ model: "bundles", data: change.row });
          break;
        case "update":
          await database.update({
            model: "bundles",
            where: [{ field: "id", value: change.id }],
            update: change.update,
          });
          break;
        case "delete":
          await database.delete({
            model: "bundles",
            where: [{ field: "id", value: change.id }],
          });
          break;
      }
      continue;
    }

    switch (change.operation) {
      case "insert":
        await database.create({ model: "bundle_patches", data: change.row });
        break;
      case "delete":
        await database.delete({
          model: "bundle_patches",
          where: [{ field: "bundle_id", value: change.bundleId }],
        });
        break;
    }
  }
  return { applied: true };
};

const createCore = (
  name: string,
  implementation: DatabasePluginImplementation,
): Omit<DatabasePlugin, "name" | "onDatabaseUpdated"> => {
  const crud = createDatabasePluginCrud(implementation);
  const transaction = implementation.transaction;
  const commit = implementation.commit
    ? implementation.commit
    : async (input: DatabaseCommit): Promise<DatabaseCommitResult> => {
        if (transaction) {
          return transaction((database) =>
            applyChanges(createTransactionDatabasePlugin(database), input),
          );
        }
        if (input.changes.length > 1) {
          throw new DatabaseAtomicCommitUnsupportedError(name);
        }
        return applyChanges(crud, input);
      };
  const commitBatch = implementation.commitBatch
    ? implementation.commitBatch
    : transaction
      ? (inputs: readonly DatabaseCommit[]) =>
          transaction(async (database) => {
            const transactionCrud = createTransactionDatabasePlugin(database);
            const results: DatabaseCommitResult[] = [];
            for (const input of inputs) {
              results.push(await applyChanges(transactionCrud, input));
            }
            return results;
          })
      : undefined;

  return {
    bundles: {
      findById: (id): Promise<BundleRow | null> =>
        crud.findOne({
          model: "bundles",
          where: [{ field: "id", value: id }],
        }),
      findMany: (query): Promise<readonly BundleRow[]> =>
        crud.findMany({
          model: "bundles",
          where: toBundleWhere(query.where),
          limit: query.limit,
          offset: query.offset,
          orderBy: [query.orderBy],
        }),
      count: (where) =>
        crud.count({ model: "bundles", where: toBundleWhere(where) }),
    },
    bundlePatches: {
      async findByBundleIds(bundleIds): Promise<readonly BundlePatchRow[]> {
        if (bundleIds.length === 0) return [];
        const rows: BundlePatchRow[] = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const page = await crud.findMany({
            model: "bundle_patches",
            where: [{ field: "bundle_id", operator: "in", value: bundleIds }],
            limit: PAGE_SIZE,
            offset,
            orderBy: [{ field: "id", direction: "asc" }],
          });
          rows.push(...page);
          if (page.length < PAGE_SIZE) return rows;
        }
      },
    },
    commit,
    ...(commitBatch ? { commitBatch } : {}),
    ...(implementation.getChannels
      ? { getChannels: implementation.getChannels }
      : {}),
    ...(implementation.getUpdateInfo
      ? { getUpdateInfo: implementation.getUpdateInfo }
      : {}),
    ...(implementation.onUnmount
      ? { onUnmount: implementation.onUnmount }
      : {}),
  };
};

export const createDatabasePlugin = (
  options: CreateDatabasePluginOptions,
): DatabasePlugin => ({
  name: options.name,
  ...createCore(options.name, options.plugin()),
});
