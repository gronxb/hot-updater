import type { BundleEventRow, BundlePatchRow } from "@hot-updater/plugin-core";

import type { StoredBundleRow } from "./databasePluginUtils";
import type { DrizzleConfig } from "./drizzle";

export type DrizzleTable = Record<string, unknown>;

type DrizzleMutation = {
  readonly execute: () => Promise<unknown>;
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
  readonly insert: (table: DrizzleTable) => {
    values: (value: unknown) => DrizzleMutation;
  };
  readonly query: {
    readonly bundle_events?: DrizzleQuery<BundleEventRow>;
    readonly bundles: DrizzleQuery<StoredBundleRow>;
    readonly bundle_patches: DrizzleQuery<BundlePatchRow>;
  };
  readonly update: (table: DrizzleTable) => {
    set: (values: unknown) => {
      where: (condition: unknown) => DrizzleMutation;
    };
  };
  readonly transaction?: <TResult>(
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
    !isDrizzleQuery(query["bundles"])
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

export const requireDrizzleBundleEventsQuery = (
  db: DrizzleDB,
): DrizzleQuery<BundleEventRow> => {
  const query = db.query.bundle_events;
  if (!query) {
    throw new InvalidDrizzleDatabaseError(
      "Drizzle Analytics requires query mode with the bundle_events schema.",
    );
  }
  return query;
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
      values: (value) => ({
        execute: async () =>
          (await getDB()).insert(table).values(value).execute(),
      }),
    }),
    query: {
      bundle_events: {
        findFirst: async (args) =>
          requireDrizzleBundleEventsQuery(await getDB()).findFirst(args),
        findMany: async (args) =>
          requireDrizzleBundleEventsQuery(await getDB()).findMany(args),
      },
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
