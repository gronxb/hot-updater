import { SETTINGS_TABLE } from "../database/fence";
import type {
  SqlConnection,
  SqlDialect,
  SqlExecutor,
} from "../database/sql/sqlAdapter";
import { quoteSql } from "../database/sql/sqlSchema";

/** The members of a Prisma client, or of its transaction client, the executor uses. */
export interface PrismaRawClient {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface PrismaTransactionalClient extends PrismaRawClient {
  $transaction<T>(
    fn: (tx: PrismaRawClient) => Promise<T>,
    options?: { readonly maxWait?: number; readonly timeout?: number },
  ): Promise<T>;
}

/**
 * Prisma reports a raw query's database error as P2010 with the database's
 * code in `meta.code`, and a failed transaction as P2034. The error thrown on
 * carries that code, as the SQL core classifies it, with Prisma's as `cause`.
 */
const withDatabaseCode = (dialect: SqlDialect, error: unknown): unknown => {
  const { code, meta } = (error ?? {}) as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
  };
  const database =
    code === "P2034"
      ? "40001"
      : meta?.code === undefined
        ? undefined
        : String(meta.code);
  if (database === undefined) return error;
  return Object.assign(
    new Error(String(meta?.message ?? (error as Error).message), {
      cause: error,
    }),
    { code: dialect === "sqlite" ? `SQLITE:${database}` : database },
  );
};

/** MySQL's ASCII keys are `VarBinary` in Prisma's schema, and read back as bytes. */
const decoder = new TextDecoder();
const decodeRow = (row: Record<string, unknown>) => {
  for (const [column, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) row[column] = decoder.decode(value);
  }
  return row;
};

const over = (dialect: SqlDialect, client: PrismaRawClient): SqlConnection => ({
  async execute({ sql, params }) {
    try {
      if (/^\s*SELECT\b/iu.test(sql)) {
        const rows = (await client.$queryRawUnsafe(sql, ...params)) as Record<
          string,
          unknown
        >[];
        return { rows: rows.map(decodeRow), changes: 0 };
      }
      return {
        rows: [],
        changes: Number(await client.$executeRawUnsafe(sql, ...params)),
      };
    } catch (error) {
      throw withDatabaseCode(dialect, error);
    }
  },
});

/** Taking the write lock first makes a SQLite transaction behave as BEGIN IMMEDIATE. */
const writeLock = (dialect: SqlDialect) =>
  `UPDATE ${quoteSql(dialect, SETTINGS_TABLE.name)} SET ${quoteSql(dialect, "_v")} = ${quoteSql(dialect, "_v")} WHERE 0 = 1`;

/**
 * The SQL core's executor over a Prisma client, through raw queries and
 * interactive transactions. A SQLite transaction takes the write lock with
 * its first statement, as BEGIN IMMEDIATE would.
 */
export const prismaExecutor = (
  client: PrismaTransactionalClient,
  dialect: SqlDialect,
): SqlExecutor => ({
  dialect,
  ...over(dialect, client),
  async transaction(fn) {
    try {
      return await client.$transaction(
        async (tx) => {
          const connection = over(dialect, tx);
          if (dialect === "sqlite") {
            await connection.execute({ sql: writeLock(dialect), params: [] });
          }
          return fn(connection);
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      throw withDatabaseCode(dialect, error);
    }
  },
});
