import type {
  BundlePatchRow,
  ChannelRow,
  ApiKeyRow,
  ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import type { SQL } from "drizzle-orm";

import type { StoredBundleRow, StoredReleaseRow } from "./databasePluginUtils";
import type { DrizzleConfig } from "./drizzle";

export type DrizzleTable = Record<string, unknown>;

type DrizzleMutation = {
  readonly execute: () => Promise<unknown>;
};

export type DrizzleInsertMutation = DrizzleMutation & {
  readonly onConflictDoNothing?: () => DrizzleMutation;
};

type DrizzleInsertBuilder = {
  readonly ignore?: () => Pick<DrizzleInsertBuilder, "values">;
  readonly values: (value: unknown) => DrizzleInsertMutation;
};

type DrizzleQuery<TRow> = {
  readonly findFirst: (args?: unknown) => Promise<TRow | undefined>;
  readonly findMany: (args?: unknown) => Promise<TRow[]>;
};

export type DrizzleDB = {
  readonly _: { readonly fullSchema: Record<string, DrizzleTable> };
  readonly $count: (table: DrizzleTable, where?: unknown) => Promise<number>;
  readonly delete: (table: DrizzleTable) => {
    where: (condition: unknown) => DrizzleMutation;
  };
  readonly insert: (table: DrizzleTable) => DrizzleInsertBuilder;
  readonly query: {
    readonly bundles: DrizzleQuery<StoredBundleRow>;
    readonly channels: DrizzleQuery<ChannelRow>;
    readonly bundle_patches: DrizzleQuery<BundlePatchRow>;
    readonly api_keys: DrizzleQuery<ApiKeyRow>;
    readonly releases: DrizzleQuery<StoredReleaseRow>;
    readonly release_catalogs: DrizzleQuery<ReleaseCatalogRow>;
  };
  readonly update: (table: DrizzleTable) => {
    set: (values: unknown) => {
      where: (condition: unknown) => DrizzleMutation;
    };
  };
  readonly transaction?: <TResult>(
    operation: (transaction: DrizzleDB) => Promise<TResult>,
  ) => Promise<TResult>;
  readonly insightsQuery?: (
    query: SQL,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly insightsMutation?: (query: SQL) => Promise<void>;
  readonly insightsTransaction?: <TResult>(
    operation: (transaction: DrizzleDB) => Promise<TResult>,
  ) => Promise<TResult>;
};

class InvalidDrizzleDatabaseError extends Error {
  readonly name = "InvalidDrizzleDatabaseError";

  constructor(readonly reason: string) {
    super(`[hot-updater] ${reason}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasFunction = (value: Record<string, unknown>, key: string): boolean =>
  typeof value[key] === "function";

const isDrizzleQuery = (value: unknown): boolean =>
  isRecord(value) &&
  hasFunction(value, "findFirst") &&
  hasFunction(value, "findMany");

const isDrizzleDB = (value: unknown): value is DrizzleDB => {
  if (!isRecord(value)) return false;
  const metadata = value["_"];
  if (!isRecord(metadata) || !isRecord(metadata["fullSchema"])) return false;
  const query = value["query"];
  if (
    !isRecord(query) ||
    !isDrizzleQuery(query["bundle_patches"]) ||
    !isDrizzleQuery(query["bundles"]) ||
    !isDrizzleQuery(query["channels"]) ||
    !isDrizzleQuery(query["api_keys"]) ||
    !isDrizzleQuery(query["releases"]) ||
    !isDrizzleQuery(query["release_catalogs"])
  ) {
    return false;
  }
  if (
    value["transaction"] !== undefined &&
    !hasFunction(value, "transaction")
  ) {
    return false;
  }
  return (
    hasFunction(value, "$count") &&
    hasFunction(value, "delete") &&
    hasFunction(value, "insert") &&
    hasFunction(value, "update")
  );
};

const asDB = (db: unknown): DrizzleDB => {
  if (!isDrizzleDB(db)) {
    throw new InvalidDrizzleDatabaseError(
      "Drizzle adapter requires query mode with schema.",
    );
  }
  return db;
};

const queryRows = (value: unknown): readonly Record<string, unknown>[] => {
  const rows =
    isRecord(value) && Array.isArray(value["rows"])
      ? value["rows"]
      : Array.isArray(value) && Array.isArray(value[0])
        ? value[0]
        : value;
  if (
    !Array.isArray(rows) ||
    rows.some((row) => !isRecord(row) || Array.isArray(row))
  ) {
    throw new InvalidDrizzleDatabaseError(
      "Drizzle Insights query returned an invalid result.",
    );
  }
  return rows;
};

const executeQuery = async (
  db: DrizzleDB,
  query: SQL,
): Promise<readonly Record<string, unknown>[]> => {
  if (db.insightsQuery !== undefined) return db.insightsQuery(query);
  const value: unknown = db;
  if (!isRecord(value)) {
    throw new InvalidDrizzleDatabaseError("Invalid Drizzle database.");
  }
  if (hasFunction(value, "all")) {
    return queryRows(
      await (value["all"] as (query: SQL) => Promise<unknown>)(query),
    );
  }
  if (hasFunction(value, "execute")) {
    return queryRows(
      await (value["execute"] as (query: SQL) => Promise<unknown>)(query),
    );
  }
  throw new InvalidDrizzleDatabaseError(
    "Drizzle Insights requires raw query execution support.",
  );
};

const executeMutation = async (db: DrizzleDB, query: SQL): Promise<void> => {
  if (db.insightsMutation !== undefined) return db.insightsMutation(query);
  const value: unknown = db;
  if (!isRecord(value)) {
    throw new InvalidDrizzleDatabaseError("Invalid Drizzle database.");
  }
  if (hasFunction(value, "run")) {
    await (value["run"] as (query: SQL) => Promise<unknown>)(query);
    return;
  }
  if (hasFunction(value, "execute")) {
    await (value["execute"] as (query: SQL) => Promise<unknown>)(query);
    return;
  }
  throw new InvalidDrizzleDatabaseError(
    "Drizzle Insights requires raw mutation execution support.",
  );
};

export const queryDrizzleInsights = <TRow extends Record<string, unknown>>(
  db: DrizzleDB,
  query: SQL,
): Promise<readonly TRow[]> =>
  executeQuery(db, query) as Promise<readonly TRow[]>;

export const mutateDrizzleInsights = (
  db: DrizzleDB,
  query: SQL,
): Promise<void> => executeMutation(db, query);

export const transactDrizzleInsights = <TResult>(
  db: DrizzleDB,
  operation: (transaction: DrizzleDB) => Promise<TResult>,
): Promise<TResult> => {
  if (db.insightsTransaction !== undefined) {
    return db.insightsTransaction(operation);
  }
  if (db.transaction === undefined) {
    throw new InvalidDrizzleDatabaseError(
      "Drizzle Insights requires transaction support.",
    );
  }
  return db.transaction(operation);
};

const isDBFactory = (
  db: DrizzleConfig["db"],
): db is () => unknown | Promise<unknown> => typeof db === "function";

const parseSchema = (
  schema: Record<string, unknown>,
): Record<string, DrizzleTable> => {
  const parsed: Record<string, DrizzleTable> = {};
  for (const [name, table] of Object.entries(schema)) {
    if (!isRecord(table)) {
      throw new InvalidDrizzleDatabaseError(
        `Drizzle schema table "${name}" is invalid.`,
      );
    }
    parsed[name] = table;
  }
  return parsed;
};

export const createLazyDB = (config: DrizzleConfig): DrizzleDB => {
  if (!isDBFactory(config.db)) return asDB(config.db);
  if (!config.schema) {
    throw new InvalidDrizzleDatabaseError(
      "Drizzle adapter requires schema when db is lazy.",
    );
  }

  const source = config.db;
  let resolvedDB: Promise<DrizzleDB> | undefined;
  const getDB = (): Promise<DrizzleDB> => {
    resolvedDB ??= Promise.resolve(source()).then(asDB);
    return resolvedDB;
  };
  return {
    _: { fullSchema: parseSchema(config.schema) },
    $count: async (table, where) => (await getDB()).$count(table, where),
    delete: (table) => ({
      where: (condition) => ({
        execute: async () =>
          (await getDB()).delete(table).where(condition).execute(),
      }),
    }),
    insert: (table) => ({
      ignore: () => ({
        values: (value) => ({
          execute: async () => {
            const insert = (await getDB()).insert(table).ignore;
            if (insert === undefined) {
              throw new InvalidDrizzleDatabaseError(
                "The resolved Drizzle database does not support insert ignore.",
              );
            }
            return insert().values(value).execute();
          },
        }),
      }),
      values: (value) => ({
        execute: async () =>
          (await getDB()).insert(table).values(value).execute(),
        onConflictDoNothing: () => ({
          execute: async () => {
            const insert = (await getDB()).insert(table).values(value);
            if (insert.onConflictDoNothing === undefined) {
              throw new InvalidDrizzleDatabaseError(
                "The resolved Drizzle database does not support conflict-ignore inserts.",
              );
            }
            return insert.onConflictDoNothing().execute();
          },
        }),
      }),
    }),
    query: {
      bundle_patches: {
        findFirst: async (args) =>
          (await getDB()).query.bundle_patches.findFirst(args),
        findMany: async (args) =>
          (await getDB()).query.bundle_patches.findMany(args),
      },
      bundles: {
        findFirst: async (args) =>
          (await getDB()).query.bundles.findFirst(args),
        findMany: async (args) => (await getDB()).query.bundles.findMany(args),
      },
      channels: {
        findFirst: async (args) =>
          (await getDB()).query.channels.findFirst(args),
        findMany: async (args) => (await getDB()).query.channels.findMany(args),
      },
      api_keys: {
        findFirst: async (args) =>
          (await getDB()).query.api_keys.findFirst(args),
        findMany: async (args) => (await getDB()).query.api_keys.findMany(args),
      },
      releases: {
        findFirst: async (args) =>
          (await getDB()).query.releases.findFirst(args),
        findMany: async (args) => (await getDB()).query.releases.findMany(args),
      },
      release_catalogs: {
        findFirst: async (args) =>
          (await getDB()).query.release_catalogs.findFirst(args),
        findMany: async (args) =>
          (await getDB()).query.release_catalogs.findMany(args),
      },
    },
    update: (table) => ({
      set: (values) => ({
        where: (condition) => ({
          execute: async () =>
            (await getDB())
              .update(table)
              .set(values)
              .where(condition)
              .execute(),
        }),
      }),
    }),
    insightsQuery: async (query) => executeQuery(await getDB(), query),
    insightsMutation: async (query) => executeMutation(await getDB(), query),
    insightsTransaction: async <TResult>(
      operation: (transaction: DrizzleDB) => Promise<TResult>,
    ): Promise<TResult> => {
      const db = await getDB();
      if (db.transaction === undefined) {
        throw new InvalidDrizzleDatabaseError(
          "The resolved Drizzle database does not support transactions.",
        );
      }
      return db.transaction(operation);
    },
    ...(config.transaction === true
      ? {
          transaction: async <TResult>(
            operation: (transaction: DrizzleDB) => Promise<TResult>,
          ): Promise<TResult> => {
            const db = await getDB();
            if (db.transaction === undefined) {
              throw new InvalidDrizzleDatabaseError(
                "The resolved Drizzle database does not support transactions.",
              );
            }
            return db.transaction(operation);
          },
        }
      : {}),
  };
};
