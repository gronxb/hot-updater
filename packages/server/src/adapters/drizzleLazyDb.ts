import type { DrizzleConfig } from "./drizzle";

export type DrizzleTable = Record<string, unknown>;

export type DrizzleDb = {
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
    operation: (tx: DrizzleDb) => Promise<T>,
  ) => Promise<T>;
};

const asDb = (db: unknown): DrizzleDb => {
  const typed = db as DrizzleDb;
  if (!typed._?.fullSchema) {
    throw new Error(
      "[hot-updater] Drizzle adapter requires query mode with schema.",
    );
  }
  return typed;
};

const isDbFactory = (
  db: DrizzleConfig["db"],
): db is () => unknown | Promise<unknown> => typeof db === "function";

export const createLazyDb = (config: DrizzleConfig): DrizzleDb => {
  const dbSource = config.db;
  if (!isDbFactory(dbSource)) return asDb(dbSource);

  if (!config.schema) {
    throw new Error(
      "[hot-updater] Drizzle adapter requires schema when db is lazy.",
    );
  }

  let resolvedDb: Promise<DrizzleDb> | undefined;
  const getDb = async () => {
    resolvedDb ??= Promise.resolve(dbSource()).then(asDb);
    return resolvedDb;
  };
  const fullSchema = config.schema as Record<string, DrizzleTable>;
  const runInserted = async (
    table: DrizzleTable,
    value: unknown,
    operation: (
      inserted: ReturnType<ReturnType<DrizzleDb["insert"]>["values"]>,
    ) => Promise<unknown> | unknown,
  ) => {
    const db = await getDb();
    return operation(db.insert(table).values(value));
  };

  return {
    _: { fullSchema },
    $count: async (table, where) => (await getDb()).$count(table, where),
    delete: (table) => ({
      where: async (condition) =>
        (await getDb()).delete(table).where(condition),
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
            (await getDb()).query[String(tableName)]?.findFirst(args),
          findMany: async (args?: unknown) =>
            (await getDb()).query[String(tableName)]?.findMany(args) ?? [],
        }),
      },
    ) as DrizzleDb["query"],
    select: (fields) => ({
      from: (table) => ({
        offset: async (offset) =>
          (await getDb()).select(fields).from(table).offset?.(offset) ?? [],
      }),
    }),
    update: (table) => ({
      set: (values) => ({
        where: async (condition) =>
          (await getDb()).update(table).set(values).where(condition),
      }),
    }),
    transaction: async (operation) => {
      const db = await getDb();
      if (typeof db.transaction !== "function") return operation(db);
      return db.transaction(operation);
    },
  };
};
