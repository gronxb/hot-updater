import { createDatabaseReadModels } from "./createDatabaseReadModels";
import { validateDatabaseCommit } from "./databaseCommitValidation";
import { createDatabasePluginCrud } from "./databasePluginCrud";
import { DatabasePluginInputError } from "./databasePluginCrudValidation";
import { isChannelText } from "./databasePluginCrudValidationFields";
import {
  validateCreateData,
  validateResult,
} from "./databasePluginCrudValidationRows";
import { createTransactionDatabasePlugin } from "./databasePluginTransaction";
import {
  compareInsightsText,
  createValidatedInsightsModel,
} from "./insightsContract";
import type {
  BundleEventRow,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  ApiKeyRow,
  DatabaseChange,
  DatabaseCommit,
  DatabaseCommitExpectation,
  DatabaseCommitResult,
  DatabasePlugin,
  DatabasePluginCrud,
  DatabasePluginImplementation,
  NativeDatabasePluginImplementation,
  DatabaseWhere,
  InsightsBundleEventFilter,
  InsightsEventFilter,
  InsightsListEventsInput,
  ReleaseRow,
} from "./types/internal";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrud";

const PAGE_SIZE = 100;

const compareChannelRows = (left: ChannelRow, right: ChannelRow): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

const toInsightsBundleWhere = (
  filter: InsightsBundleEventFilter,
): readonly DatabaseWhere<"bundle_events">[] => [
  { field: "platform", value: filter.platform },
  { field: "channel", value: filter.channel },
  { field: "type", value: filter.type },
  filter.type === "RECOVERED"
    ? { field: "from_bundle_id", value: filter.fromBundleId }
    : { field: "to_bundle_id", value: filter.toBundleId },
];

const toInsightsEventRanges = (
  filter: InsightsEventFilter,
): readonly (readonly DatabaseWhere<"bundle_events">[])[] => {
  if (filter.kind === "all") return [[]];
  if (filter.kind === "bundle") return [toInsightsBundleWhere(filter)];
  return (["UPDATE_DOWNLOADED", "UPDATE_APPLIED", "RECOVERED"] as const).map(
    (type) => [
      { field: "install_id", value: filter.installId },
      { field: "type", value: type },
    ],
  );
};

const listInsightsEventRange = async (
  crud: DatabasePluginCrud,
  input: InsightsListEventsInput,
  filterWhere: readonly DatabaseWhere<"bundle_events">[],
): Promise<readonly BundleEventRow[]> => {
  const where: readonly DatabaseWhere<"bundle_events">[] = [
    ...filterWhere,
    { field: "received_at_ms", operator: "gte", value: input.sinceMs ?? 0 },
  ];
  // Disjoint indexed ranges preserve the tuple cursor without offsets.
  const sameTimestamp =
    input.after === undefined
      ? []
      : await crud.findMany({
          model: "bundle_events",
          where: [
            ...filterWhere,
            { field: "received_at_ms", value: input.after.receivedAtMs },
            { field: "id", operator: "lt", value: input.after.id },
          ],
          orderBy: [{ field: "id", direction: "desc" }],
          limit: input.limit,
          offset: 0,
        });
  if (sameTimestamp.length === input.limit) return sameTimestamp;
  const older = await crud.findMany({
    model: "bundle_events",
    where: [
      ...where,
      {
        field: "received_at_ms",
        operator: "lt",
        value: input.after?.receivedAtMs ?? input.beforeReceivedAtMs,
      },
    ],
    orderBy: [
      { field: "received_at_ms", direction: "desc" },
      { field: "id", direction: "desc" },
    ],
    limit: input.limit - sameTimestamp.length,
    offset: 0,
  });
  return [...sameTimestamp, ...older];
};

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

export type DatabasePluginAdapter = DatabasePlugin;

const assertReleaseReferences = async (
  database: DatabasePluginCrud,
  row: ReleaseRow,
): Promise<void> => {
  const channel = await database.findOne({
    model: "channels",
    where: [{ field: "id", value: row.channel_id }],
  });
  if (channel === null) {
    throw new DatabasePluginInputError("invalid-data");
  }
  if (row.bundle_id !== null) {
    const bundle = await database.findOne({
      model: "bundles",
      where: [{ field: "id", value: row.bundle_id }],
    });
    if (bundle === null || bundle.platform !== row.platform) {
      throw new DatabasePluginInputError("invalid-data");
    }
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
          await database.create({ model: "bundles", data: change.row });
          return;
        case "update": {
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
          if (
            (await database.count({
              model: "releases",
              where: [{ field: "bundle_id", value: change.where.id }],
            })) > 0
          ) {
            throw new DatabaseCommitConflictError({
              committed: false,
              conflict: { changeIndex, reason: "referenced" },
            });
          }
          await database.delete({
            model: "bundles",
            where: [{ field: "id", value: change.where.id }],
          });
          return;
      }
    case "releases":
      switch (change.operation) {
        case "insert":
          await assertReleaseReferences(database, change.row);
          await database.create({ model: "releases", data: change.row });
          return;
        case "update": {
          const row = await database.update({
            model: "releases",
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
            model: "releases",
            where: [{ field: "id", value: change.where.id }],
          });
          return;
      }
    case "releaseCatalogs": {
      const current = await database.findOne({
        model: "release_catalogs",
        where: [{ field: "scope_key", value: change.row.scope_key }],
      });
      if (current === null) {
        await database.create({
          model: "release_catalogs",
          data: change.row,
        });
      } else {
        const { scope_key: _scopeKey, ...update } = change.row;
        await database.update({
          model: "release_catalogs",
          where: [{ field: "scope_key", value: change.row.scope_key }],
          update,
        });
      }
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
          const referencedReleases = await database.count({
            model: "releases",
            where: [{ field: "channel_id", value: change.where.id }],
          });
          if (referencedReleases > 0) {
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
    case "apiKeys":
      switch (change.operation) {
        case "insert":
          await database.create({
            model: "api_keys",
            data: change.row,
            onConflict: change.onConflict,
          });
          return;
        case "update": {
          const row = await database.update({
            model: "api_keys",
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

const expectationVersion = async (
  database: DatabasePluginCrud,
  expectation: DatabaseCommitExpectation,
): Promise<number | null> => {
  if (expectation.model === "releases") {
    const row = await database.findOne({
      model: "releases",
      where: [{ field: "id", value: expectation.id }],
      select: ["revision"],
    });
    return row?.revision ?? null;
  }
  const row = await database.findOne({
    model: "release_catalogs",
    where: [{ field: "scope_key", value: expectation.scopeKey }],
    select: ["generation"],
  });
  return row?.generation ?? null;
};

const applyExpectations = async (
  database: DatabasePluginCrud,
  expectations: readonly DatabaseCommitExpectation[],
): Promise<void> => {
  for (const expectation of expectations) {
    const expectedVersion =
      expectation.model === "releases"
        ? expectation.revision
        : expectation.generation;
    const actualVersion = await expectationVersion(database, expectation);
    if (actualVersion !== expectedVersion) {
      throw new DatabaseCommitConflictError({
        committed: false,
        conflict: {
          actualVersion,
          changeIndex: -1,
          expectedVersion,
          key:
            expectation.model === "releases"
              ? expectation.id
              : expectation.scopeKey,
          model: expectation.model,
          reason: "version_conflict",
        },
      });
    }
  }
};

const applyChanges = async (
  database: DatabasePluginCrud,
  input: DatabaseCommit,
): Promise<DatabaseCommitResult> => {
  await applyExpectations(database, input.expectations ?? []);
  for (const [changeIndex, change] of input.changes.entries()) {
    await applyChange(database, change, changeIndex);
  }
  return { committed: true };
};

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

const buildDatabasePluginAdapter = (
  name: string,
  implementation:
    | DatabasePluginImplementation
    | NativeDatabasePluginImplementation
    | (() => DatabasePluginImplementation),
): DatabasePluginAdapter => {
  if (typeof implementation === "function") {
    let adapter: DatabasePluginAdapter | undefined;
    const getAdapter = () =>
      (adapter ??= buildDatabasePluginAdapter(name, implementation()));
    return {
      name,
      models: {
        bundles: {
          findById: (id) => getAdapter().models.bundles.findById(id),
          findMany: (query) => getAdapter().models.bundles.findMany(query),
          count: (where) => getAdapter().models.bundles.count(where),
        },
        bundlePatches: {
          findByBaseBundleIds: (ids) =>
            getAdapter().models.bundlePatches.findByBaseBundleIds!(ids),
          findByBundleIds: (bundleIds) =>
            getAdapter().models.bundlePatches.findByBundleIds(bundleIds),
        },
        releases: {
          findById: (id) => getAdapter().models.releases.findById(id),
          findMany: (input) => getAdapter().models.releases.findMany(input),
          findManyByScope: (input) =>
            getAdapter().models.releases.findManyByScope(input),
        },
        releaseCatalogs: {
          findByScopeKey: (scopeKey) =>
            getAdapter().models.releaseCatalogs.findByScopeKey(scopeKey),
          findMany: (input) =>
            getAdapter().models.releaseCatalogs.findMany(input),
        },
        channels: {
          insert: (input) => getAdapter().models.channels.insert(input),
          list: (input) => getAdapter().models.channels.list(input),
          delete: (input) => getAdapter().models.channels.delete(input),
        },
        insights: {
          recordEvent: (input) =>
            getAdapter().models.insights.recordEvent(input),
          listEvents: (input) => getAdapter().models.insights.listEvents(input),
          findLatestEvents: (input) =>
            getAdapter().models.insights.findLatestEvents(input),
          countLatestEvents: (input) =>
            getAdapter().models.insights.countLatestEvents(input),
          countEvents: (input) =>
            getAdapter().models.insights.countEvents(input),
          getReleaseActivity: (input) =>
            getAdapter().models.insights.getReleaseActivity(input),
          getAppUsage: (input) =>
            getAdapter().models.insights.getAppUsage(input),
        },
        apiKeys: {
          create: (row) => getAdapter().models.apiKeys.create(row),
          findByHash: (hash) => getAdapter().models.apiKeys.findByHash(hash),
          list: () => getAdapter().models.apiKeys.list(),
          revoke: (input) => getAdapter().models.apiKeys.revoke(input),
        },
      },
      commit: (input) => getAdapter().commit(input),
      // Schema-only use must not initialize a connection just to dispose it.
      dispose: async () => {
        await adapter?.dispose?.();
      },
    };
  }
  if ("read" in implementation) {
    return {
      name,
      models: {
        ...createDatabaseReadModels(
          implementation.read,
          implementation.models.bundlePatches,
        ),
        channels: implementation.models.channels,
        insights: implementation.models.insights,
        apiKeys: implementation.models.apiKeys,
      },
      commit: implementation.commit,
      ...(implementation.dispose ? { dispose: implementation.dispose } : {}),
    };
  }
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
          (input.expectations?.length ?? 0) > 0 ||
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
  const findApiKeyByHash = (
    database: DatabasePluginCrud,
    hash: string,
  ): Promise<ApiKeyRow | null> =>
    database.findOne({
      model: "api_keys",
      where: [{ field: "hash", value: hash }],
    });

  return {
    name,
    models: {
      ...createDatabaseReadModels(implementation),
      channels: {
        insert: (input) => implementation.insertChannel(input),
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
        delete: (input) => implementation.deleteChannel(input),
      },
      insights: {
        recordEvent: (input) => implementation.recordInsights(input),
        async listEvents(input) {
          const ranges = await Promise.all(
            toInsightsEventRanges(input.filter).map((where) =>
              listInsightsEventRange(crud, input, where),
            ),
          );
          if (ranges.length === 1) return ranges[0]!;
          // A fixed type per query preserves the movement index's time order.
          // Merge at most two bounded pages, never the installation history.
          return ranges
            .flat()
            .sort(
              (left, right) =>
                right.received_at_ms - left.received_at_ms ||
                compareInsightsText(right.id, left.id),
            )
            .slice(0, input.limit);
        },
        findLatestEvents: (input) =>
          implementation.findLatestInsightsEvents(input),
        countLatestEvents: (input) =>
          implementation.countLatestInsightsEvents(input),
        countEvents(input) {
          return crud.count({
            model: "bundle_events",
            where: [
              ...toInsightsBundleWhere(input.filter),
              {
                field: "received_at_ms",
                operator: "gte",
                value: input.sinceMs,
              },
              {
                field: "received_at_ms",
                operator: "lt",
                value: input.beforeReceivedAtMs,
              },
            ],
          });
        },
        getReleaseActivity: (input) => implementation.getReleaseActivity(input),
        getAppUsage: (input) => implementation.getAppUsage(input),
      },
      apiKeys: {
        async create(row) {
          const run = async (database: DatabasePluginCrud) => {
            if ((await findApiKeyByHash(database, row.hash)) !== null) {
              return "existing" as const;
            }
            await database.create({ model: "api_keys", data: row });
            return "created" as const;
          };
          return transaction
            ? transaction((database) =>
                run(createTransactionDatabasePlugin(database)),
              )
            : run(crud);
        },
        findByHash: (hash) => findApiKeyByHash(crud, hash),
        list: () =>
          crud.findMany({
            model: "api_keys",
            orderBy: [
              { field: "created_at_ms", direction: "desc" },
              { field: "id", direction: "asc" },
            ],
            limit: Number.MAX_SAFE_INTEGER,
            offset: 0,
          }),
        async revoke({ id, revokedAtMs }) {
          return crud.update({
            model: "api_keys",
            where: [{ field: "id", value: id }],
            update: { revoked_at_ms: revokedAtMs },
          });
        },
      },
    },
    commit: executeCommit,
    ...(implementation.dispose ? { dispose: implementation.dispose } : {}),
  };
};

/** The factory owns validation, native/transactional execution and lazy lifecycle. */
export const createDatabasePluginAdapter = (
  ...args: Parameters<typeof buildDatabasePluginAdapter>
): DatabasePluginAdapter =>
  createDatabasePlugin(buildDatabasePluginAdapter(...args));

/** Shared contract boundary for both native models and the CRUD adapter. */
export const createDatabasePlugin = (
  options: CreateDatabasePluginOptions,
): DatabasePlugin => ({
  ...options,
  async commit(input) {
    validateDatabaseCommit(input);
    return options.commit(input);
  },
  models: {
    ...options.models,
    channels: {
      list: (input) => options.models.channels.list(input),
      async insert(input) {
        if (input.onConflict !== "returnExisting") {
          throw new DatabasePluginInputError("invalid-operation");
        }
        validateCreateData("channels", input.row);
        const result = await options.models.channels.insert(input);
        validateChannelInsertResult(input, result);
        return result;
      },
      async delete(input) {
        if (!isChannelText(input.id)) {
          throw new DatabasePluginInputError("invalid-data");
        }
        const result = await options.models.channels.delete(input);
        validateChannelDeleteResult(result);
        return result;
      },
    },
    insights: createValidatedInsightsModel(options.models.insights),
  },
});
