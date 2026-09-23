import type { DatabasePlugin } from "@hot-updater/plugin-core";
import {
  createLegacyDatabasePlugin,
  createSqlAdapter,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
} from "@hot-updater/server/database";

/** A D1 result, from the binding or the REST API. */
export interface D1ResultLike {
  readonly results?: readonly unknown[];
  readonly success?: boolean;
  readonly meta?: { readonly changes?: number };
}

export class D1ExecutionError extends Error {
  readonly name = "D1ExecutionError";
  constructor() {
    super("D1 did not successfully execute every requested statement");
  }
}

export const toSqlResult = (result: D1ResultLike): SqlResult => {
  if (result.success === false) throw new D1ExecutionError();
  return {
    rows: (result.results ?? []) as Record<string, unknown>[],
    changes: result.meta?.changes ?? 0,
  };
};

/** D1 reports SQLite errors in the message; the SQL core classifies codes. */
const withSqliteCode = (error: unknown): unknown => {
  const message = error instanceof Error ? error.message : String(error);
  const code = /UNIQUE constraint failed|constraint failed: .*PRIMARY/iu.test(
    message,
  )
    ? "SQLITE_CONSTRAINT_UNIQUE"
    : /SQLITE_BUSY|database is locked/iu.test(message)
      ? "SQLITE_BUSY"
      : undefined;
  return code === undefined
    ? error
    : Object.assign(new Error(message, { cause: error }), { code });
};

/**
 * The most ops one write sends. Each statement of a batch is one query, a
 * Worker invocation allows 1,000 queries on the paid plan, and an op takes at
 * most two statements besides the batch's three.
 */
export const D1_MAX_OPS = 450;

/**
 * Hot Updater's database on D1: the storage engine through the shared SQL
 * core, behind today's `DatabasePlugin` until E2, with the schema fence on.
 * D1 has no interactive transactions, so each write is one atomic batch that
 * evaluates its guards first (`_hu_write`).
 */
export const createD1DatabasePlugin = (runner: {
  query(statement: SqlStatement): Promise<SqlResult>;
  batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
}): DatabasePlugin => {
  const executor: SqlExecutor = {
    dialect: "sqlite",
    execute: (statement) =>
      runner.query(statement).catch((error: unknown) => {
        throw withSqliteCode(error);
      }),
    batch: (statements) =>
      runner.batch(statements).catch((error: unknown) => {
        throw withSqliteCode(error);
      }),
    transaction: () => {
      throw new Error(
        "D1 has no interactive transactions; writes are batches.",
      );
    },
  };
  return createLegacyDatabasePlugin({
    name: "d1Database",
    adapter: createSqlAdapter({ executor, maxOps: D1_MAX_OPS, maxParams: 100 }),
    fence: true,
  });
};
