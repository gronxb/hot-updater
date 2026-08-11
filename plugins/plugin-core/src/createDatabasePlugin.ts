import { createDatabasePluginCrud } from "./databasePluginCrud";
import { createTransactionDatabasePlugin } from "./databasePluginTransaction";
import type {
  BundlePatchRow,
  BundleRow,
  BundleEventRow,
  ClientAccessKeyRow,
  DatabaseBundleQueryWhere,
  DatabaseCommit,
  DatabaseCommitResult,
  DatabasePlugin,
  DatabasePluginCore,
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
  readonly bundles: DatabasePlugin["bundles"];
  readonly bundlePatches: DatabasePlugin["bundlePatches"];
  readonly analytics: DatabasePlugin["analytics"];
  readonly clientAccessKeys: DatabasePlugin["clientAccessKeys"];
  readonly commit: DatabasePlugin["commit"];
  readonly getChannels?: DatabasePlugin["getChannels"];
  readonly getUpdateInfo?: DatabasePlugin["getUpdateInfo"];
  readonly dispose?: DatabasePlugin["dispose"];
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
  for (const mutation of input.mutations) {
    if (mutation.operation !== "update") continue;
    const row = await database.findOne({
      model: "bundles",
      where: [{ field: "id", value: mutation.bundleId }],
      select: ["id"],
    });
    if (row === null) {
      return { applied: false, missingBundleId: mutation.bundleId };
    }
  }

  for (const mutation of input.mutations) {
    for (const change of mutation.changes) {
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
  }
  return { applied: true };
};

export const createDatabasePluginAdapter = (
  name: string,
  implementation: DatabasePluginImplementation,
): DatabasePluginCore => {
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
        const changeCount = input.mutations.reduce(
          (count, mutation) => count + mutation.changes.length,
          0,
        );
        if (input.mutations.length > 1 || changeCount > 1) {
          throw new DatabaseAtomicCommitUnsupportedError(name);
        }
        return applyChanges(crud, input);
      };

  const findClientAccessKeyByHash = (
    database: DatabasePluginCrud,
    hash: string,
  ): Promise<ClientAccessKeyRow | null> =>
    database.findOne({
      model: "client_access_keys",
      where: [{ field: "hash", value: hash }],
    });

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
    analytics: {
      async append(row) {
        await crud.create({ model: "bundle_events", data: row });
      },
      async scan(input) {
        const rows: BundleEventRow[] = [];
        for (let offset = 0; rows.length < input.limit; offset += PAGE_SIZE) {
          const page = await crud.findMany({
            model: "bundle_events",
            where: [
              {
                field: "received_at_ms",
                operator: "lt",
                value: input.beforeReceivedAtMs,
              },
            ],
            orderBy: [
              { field: "received_at_ms", direction: "asc" },
              { field: "id", direction: "asc" },
            ],
            limit: PAGE_SIZE,
            offset,
          });
          rows.push(
            ...page.filter(
              (row) =>
                input.after === undefined ||
                row.received_at_ms > input.after.receivedAtMs ||
                (row.received_at_ms === input.after.receivedAtMs &&
                  row.id > input.after.id),
            ),
          );
          if (page.length < PAGE_SIZE) break;
        }
        return rows.slice(0, input.limit);
      },
    },
    clientAccessKeys: {
      async create(row) {
        const run = async (database: DatabasePluginCrud) => {
          if ((await findClientAccessKeyByHash(database, row.hash)) !== null) {
            return "existing" as const;
          }
          await database.create({ model: "client_access_keys", data: row });
          return "created" as const;
        };
        return transaction
          ? transaction((database) =>
              run(createTransactionDatabasePlugin(database)),
            )
          : run(crud);
      },
      findByHash: (hash) => findClientAccessKeyByHash(crud, hash),
      list: () =>
        crud.findMany({
          model: "client_access_keys",
          orderBy: [
            { field: "created_at_ms", direction: "desc" },
            { field: "id", direction: "asc" },
          ],
          limit: Number.MAX_SAFE_INTEGER,
          offset: 0,
        }),
      async revoke({ id, revokedAtMs }) {
        return crud.update({
          model: "client_access_keys",
          where: [{ field: "id", value: id }],
          update: { revoked_at_ms: revokedAtMs },
        });
      },
    },
    commit,
    ...(implementation.getChannels
      ? { getChannels: implementation.getChannels }
      : {}),
    ...(implementation.getUpdateInfo
      ? { getUpdateInfo: implementation.getUpdateInfo }
      : {}),
    ...(implementation.dispose ? { dispose: implementation.dispose } : {}),
  };
};

export const createDatabasePlugin = (
  options: CreateDatabasePluginOptions,
): DatabasePlugin => ({ ...options });
