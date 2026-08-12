import { createDatabasePluginCrud } from "./databasePluginCrud";
import { DatabasePluginInputError } from "./databasePluginCrudValidation";
import { isChannelText, isRecord } from "./databasePluginCrudValidationFields";
import {
  validateBundleUpdateData,
  validateClientAccessKeyUpdateData,
} from "./databasePluginCrudValidationMutations";
import {
  validateCreateData,
  validateResult,
} from "./databasePluginCrudValidationRows";
import { createTransactionDatabasePlugin } from "./databasePluginTransaction";
import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  ClientAccessKeyRow,
  DatabaseBundleQueryWhere,
  DatabaseChange,
  DatabaseCommit,
  DatabaseCommitResult,
  DatabasePlugin,
  DatabasePluginCrud,
  DatabasePluginImplementation,
  DatabaseWhere,
} from "./types/internal";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrud";

const PAGE_SIZE = 100;

const compareChannelRows = (left: ChannelRow, right: ChannelRow): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

export class DatabaseAtomicCommitUnsupportedError extends Error {
  readonly name = "DatabaseAtomicCommitUnsupportedError";

  constructor(readonly pluginName: string) {
    super(
      `Database plugin "${pluginName}" cannot atomically commit changes across models.`,
    );
  }
}

/**
 * Internal provider signal for a delete rejected by a live reference.
 *
 * Provider implementations throw this after translating their native
 * foreign-key or reference-condition error. The public database contract
 * observes only the indexed `referenced` commit conflict.
 */
export class DatabaseRowReferencedError extends Error {
  readonly name = "DatabaseRowReferencedError";

  constructor() {
    super("The database row is still referenced.");
  }
}

class DatabaseCommitConflictError extends Error {
  readonly name = "DatabaseCommitConflictError";

  constructor(readonly result: DatabaseCommitResult) {
    super("Database commit precondition failed.");
  }
}

export type CreateDatabasePluginOptions = DatabasePlugin;

export type DatabasePluginAdapter = Omit<DatabasePlugin, "name">;

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

const assertBundleChannel = async (
  database: DatabasePluginCrud,
  row: Pick<BundleRow, "channel" | "channel_id">,
): Promise<void> => {
  const channel = await database.findOne({
    model: "channels",
    where: [{ field: "id", value: row.channel_id }],
  });
  if (channel === null || channel.name !== row.channel) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

const applyChange = async (
  database: DatabasePluginCrud,
  change: DatabaseChange,
  changeIndex: number,
): Promise<void> => {
  switch (change.model) {
    case "bundles":
      switch (change.operation) {
        case "insert":
          await assertBundleChannel(database, change.row);
          await database.create({ model: "bundles", data: change.row });
          return;
        case "update": {
          if (change.update.channel !== undefined) {
            await assertBundleChannel(database, {
              channel: change.update.channel,
              channel_id: change.update.channel_id,
            });
          }
          const row = await database.update({
            model: "bundles",
            where: [{ field: "id", value: change.where.id }],
            update: change.update,
          });
          if (row === null) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "not_found" },
            });
          }
          return;
        }
        case "delete":
          await database.delete({
            model: "bundles",
            where: [{ field: "id", value: change.where.id }],
          });
          return;
      }
    case "bundlePatches":
      switch (change.operation) {
        case "insert":
          await database.create({
            model: "bundle_patches",
            data: change.row,
          });
          return;
        case "delete":
          await database.delete({
            model: "bundle_patches",
            where: [{ field: "bundle_id", value: change.where.bundleId }],
          });
          return;
      }
    case "channels":
      switch (change.operation) {
        case "insert":
          await database.create({
            model: "channels",
            data: change.row,
            onConflict: change.onConflict,
          });
          return;
        case "delete": {
          const referencedBundles = await database.count({
            model: "bundles",
            where: [{ field: "channel_id", value: change.where.id }],
          });
          if (referencedBundles > 0) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "referenced" },
            });
          }
          try {
            await database.delete({
              model: "channels",
              where: [{ field: "id", value: change.where.id }],
            });
          } catch (error) {
            if (error instanceof DatabaseRowReferencedError) {
              throw new DatabaseCommitConflictError({
                committed: false,
                conflict: { changeIndex, reason: "referenced" },
              });
            }
            throw error;
          }
          return;
        }
      }
    case "analytics":
      await database.create({ model: "bundle_events", data: change.row });
      return;
    case "clientAccessKeys":
      switch (change.operation) {
        case "insert":
          await database.create({
            model: "client_access_keys",
            data: change.row,
            onConflict: change.onConflict,
          });
          return;
        case "update": {
          const row = await database.update({
            model: "client_access_keys",
            where: [{ field: "id", value: change.where.id }],
            update: { revoked_at_ms: change.update.revokedAtMs },
          });
          if (row === null) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "not_found" },
            });
          }
          return;
        }
      }
  }
};

const applyChanges = async (
  database: DatabasePluginCrud,
  input: DatabaseCommit,
): Promise<DatabaseCommitResult> => {
  for (const [changeIndex, change] of input.changes.entries()) {
    await applyChange(database, change, changeIndex);
  }
  return { committed: true };
};

const hasOnlyKeys = (
  value: Record<PropertyKey, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const validateWhere = (
  where: unknown,
  field: "bundleId" | "id",
  validateValue: (value: unknown) => boolean = (value) =>
    typeof value === "string",
): void => {
  if (
    !isRecord(where) ||
    !hasOnlyKeys(where, [field]) ||
    !validateValue(Reflect.get(where, field))
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

const validateDatabaseChange = (change: unknown): void => {
  if (!isRecord(change)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  switch (change.model) {
    case "bundles":
      switch (change.operation) {
        case "insert":
          if (!hasOnlyKeys(change, ["model", "operation", "row"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateCreateData("bundles", change.row);
          return;
        case "update":
          if (!hasOnlyKeys(change, ["model", "operation", "where", "update"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          validateBundleUpdateData(change.update);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "bundlePatches":
      switch (change.operation) {
        case "insert":
          if (!hasOnlyKeys(change, ["model", "operation", "row"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateCreateData("bundle_patches", change.row);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "bundleId");
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "channels":
      switch (change.operation) {
        case "insert":
          if (
            !hasOnlyKeys(change, ["model", "operation", "row", "onConflict"]) ||
            change.onConflict !== "ignore"
          ) {
            throw new DatabasePluginInputError("invalid-operation");
          }
          validateCreateData("channels", change.row);
          return;
        case "delete":
          if (!hasOnlyKeys(change, ["model", "operation", "where"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id", isChannelText);
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    case "analytics":
      if (
        change.operation !== "insert" ||
        !hasOnlyKeys(change, ["model", "operation", "row"])
      ) {
        throw new DatabasePluginInputError("invalid-operation");
      }
      validateCreateData("bundle_events", change.row);
      return;
    case "clientAccessKeys":
      switch (change.operation) {
        case "insert":
          if (
            !hasOnlyKeys(change, ["model", "operation", "row", "onConflict"]) ||
            change.onConflict !== "ignore"
          ) {
            throw new DatabasePluginInputError("invalid-operation");
          }
          validateCreateData("client_access_keys", change.row);
          return;
        case "update":
          if (!hasOnlyKeys(change, ["model", "operation", "where", "update"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateWhere(change.where, "id");
          if (!isRecord(change.update)) {
            throw new DatabasePluginInputError("invalid-data");
          }
          if (!hasOnlyKeys(change.update, ["revokedAtMs"])) {
            throw new DatabasePluginInputError("invalid-data");
          }
          validateClientAccessKeyUpdateData({
            revoked_at_ms: change.update.revokedAtMs,
          });
          return;
        default:
          throw new DatabasePluginInputError("invalid-operation");
      }
    default:
      throw new DatabasePluginInputError("invalid-model");
  }
};

function validateDatabaseCommit(
  input: unknown,
): asserts input is DatabaseCommit {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["changes"]) ||
    !Array.isArray(input.changes)
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
  input.changes.forEach(validateDatabaseChange);
}

const validateChannelInsertResult = (
  input: ChannelInsertInput,
  result: ChannelInsertResult,
): void => {
  validateResult("channels", result.row, undefined);
  if (
    typeof result.inserted !== "boolean" ||
    result.row.name !== input.row.name ||
    (result.inserted && result.row.id !== input.row.id)
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
};

const validateChannelDeleteResult = (
  result: Awaited<ReturnType<DatabasePluginImplementation["deleteChannel"]>>,
): void => {
  if (result.deleted) return;
  if (result.reason !== "not_found" && result.reason !== "not_empty") {
    throw new DatabasePluginInputError("invalid-result");
  }
};

export const createDatabasePluginAdapter = (
  name: string,
  implementation: DatabasePluginImplementation,
): DatabasePluginAdapter => {
  const crud = createDatabasePluginCrud(implementation);
  const transaction = implementation.transaction;
  const executeCommit = implementation.commit
    ? implementation.commit
    : async (input: DatabaseCommit): Promise<DatabaseCommitResult> => {
        if (transaction) {
          try {
            return await transaction((database) =>
              applyChanges(createTransactionDatabasePlugin(database), input),
            );
          } catch (error) {
            if (error instanceof DatabaseCommitConflictError) {
              return error.result;
            }
            throw error;
          }
        }
        if (
          input.changes.length > 1 ||
          input.changes.some(
            (change) =>
              change.model === "channels" && change.operation === "delete",
          )
        ) {
          throw new DatabaseAtomicCommitUnsupportedError(name);
        }
        try {
          return await applyChanges(crud, input);
        } catch (error) {
          if (error instanceof DatabaseCommitConflictError) return error.result;
          throw error;
        }
      };
  const commit = async (
    input: DatabaseCommit,
  ): Promise<DatabaseCommitResult> => {
    validateDatabaseCommit(input);
    return executeCommit(input);
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
    models: {
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
      channels: {
        async insert(input) {
          if (input.onConflict !== "returnExisting") {
            throw new DatabasePluginInputError("invalid-operation");
          }
          validateCreateData("channels", input.row);
          const result = await implementation.insertChannel(input);
          validateChannelInsertResult(input, result);
          return result;
        },
        async list(_input) {
          const channels: ChannelRow[] = [];
          for (let offset = 0; ; offset += PAGE_SIZE) {
            const page = await crud.findMany({
              model: "channels",
              orderBy: [{ field: "name", direction: "asc" }],
              limit: PAGE_SIZE,
              offset,
            });
            channels.push(...page);
            if (page.length < PAGE_SIZE) {
              channels.sort(compareChannelRows);
              return { channels };
            }
          }
        },
        async delete(input) {
          if (!isChannelText(input.id)) {
            throw new DatabasePluginInputError("invalid-data");
          }
          const result = await implementation.deleteChannel(input);
          validateChannelDeleteResult(result);
          return result;
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
            if (
              (await findClientAccessKeyByHash(database, row.hash)) !== null
            ) {
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
    },
    queries: implementation.getUpdateInfo
      ? { getUpdateInfo: implementation.getUpdateInfo }
      : {},
    commit,
    ...(implementation.dispose ? { dispose: implementation.dispose } : {}),
  };
};

export const createDatabasePlugin = (
  options: CreateDatabasePluginOptions,
): DatabasePlugin => ({ ...options });
