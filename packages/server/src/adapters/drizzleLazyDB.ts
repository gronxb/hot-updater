import type { DrizzleConfig } from "./drizzle";

export type DrizzleTable = Record<string, unknown>;

export type DrizzleDB = {
  readonly _: { readonly fullSchema: Record<string, DrizzleTable> };
  readonly $count: (table: DrizzleTable, where?: unknown) => Promise<number>;
  readonly delete: (table: DrizzleTable) => {
    where: (condition: unknown) => Promise<unknown>;
  };
  readonly insert: (table: DrizzleTable) => {
    values: (value: unknown) => {
      onConflictDoUpdate?: (args: unknown) => Promise<unknown>;
      onDuplicateKeyUpdate?: (args: unknown) => Promise<unknown>;
      execute?: () => Promise<unknown>;
    };
  };
  readonly query: Record<
    string,
    {
      findFirst: (
        args?: unknown,
      ) => Promise<Record<string, unknown> | undefined>;
      findMany: (args?: unknown) => Promise<Record<string, unknown>[]>;
    }
  >;
  readonly select: (fields?: unknown) => {
    from: (table: DrizzleTable) => {
      where?: (condition: unknown) => unknown;
      orderBy?: (order: unknown) => unknown;
      limit?: (limit: number) => unknown;
      offset?: (offset: number) => Promise<Record<string, unknown>[]>;
    };
  };
  readonly update: (table: DrizzleTable) => {
    set: (values: unknown) => {
      where: (condition: unknown) => Promise<unknown>;
    };
  };
  readonly transaction?: <T>(
    operation: (tx: DrizzleDB) => Promise<T>,
  ) => Promise<T>;
};

const asDB = (db: unknown): DrizzleDB => {
  const typed = db as DrizzleDB;
  if (!typed._?.fullSchema) {
    throw new Error(
      "[hot-updater] Drizzle adapter requires query mode with schema.",
    );
  }
  return typed;
};

const isDBFactory = (
  db: DrizzleConfig["db"],
): db is () => unknown | Promise<unknown> => typeof db === "function";

export const createLazyDB = (config: DrizzleConfig): DrizzleDB => {
  const dbSource = config.db;
  if (!isDBFactory(dbSource)) return asDB(dbSource);

  if (!config.schema) {
    throw new Error(
      "[hot-updater] Drizzle adapter requires schema when db is lazy.",
    );
  }

  let resolvedDB: Promise<DrizzleDB> | undefined;
  const getDB = async () => {
    resolvedDB ??= Promise.resolve(dbSource()).then(asDB);
    return resolvedDB;
  };
  const fullSchema = config.schema as Record<string, DrizzleTable>;
  const runInserted = async (
    table: DrizzleTable,
    value: unknown,
    operation: (
      inserted: ReturnType<ReturnType<DrizzleDB["insert"]>["values"]>,
    ) => Promise<unknown> | unknown,
  ) => {
    const db = await getDB();
    return operation(db.insert(table).values(value));
  };

  return {
    _: { fullSchema },
    $count: async (table, where) => (await getDB()).$count(table, where),
    delete: (table) => ({
      where: async (condition) =>
        (await getDB()).delete(table).where(condition),
    }),
    insert: (table) => ({
      values: (value) => ({
        execute: async () =>
          runInserted(table, value, async (inserted) => {
            if (typeof inserted.execute === "function") {
              return inserted.execute();
            }
            return inserted;
          }),
        onConflictDoUpdate: async (args) =>
          runInserted(table, value, async (inserted) => {
            if (typeof inserted.onConflictDoUpdate !== "function") {
              throw new Error(
                "[hot-updater] Drizzle insert does not support onConflictDoUpdate.",
              );
            }
            return inserted.onConflictDoUpdate(args);
          }),
        onDuplicateKeyUpdate: async (args) =>
          runInserted(table, value, async (inserted) => {
            if (typeof inserted.onDuplicateKeyUpdate !== "function") {
              throw new Error(
                "[hot-updater] Drizzle insert does not support onDuplicateKeyUpdate.",
              );
            }
            return inserted.onDuplicateKeyUpdate(args);
          }),
      }),
    }),
    query: new Proxy(
      {},
      {
        get: (_target, tableName) => ({
          findFirst: async (args?: unknown) =>
            (await getDB()).query[String(tableName)]?.findFirst(args),
          findMany: async (args?: unknown) =>
            (await getDB()).query[String(tableName)]?.findMany(args) ?? [],
        }),
      },
    ) as DrizzleDB["query"],
    select: (fields) => ({
      from: (table) => ({
        offset: async (offset) =>
          (await getDB()).select(fields).from(table).offset?.(offset) ?? [],
      }),
    }),
    update: (table) => ({
      set: (values) => ({
        where: async (condition) =>
          (await getDB()).update(table).set(values).where(condition),
      }),
    }),
    transaction: async (operation) => {
      const db = await getDB();
      if (typeof db.transaction !== "function") return operation(db);
      return db.transaction(operation);
    },
  };
};
