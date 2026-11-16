import {
  createEngineDatabase,
  createSqlAdapter,
  type SqlExecutor,
  type SqlResult,
  type SqlStatement,
} from "@hot-updater/plugin-core";
import type { ToolingDatabase } from "@hot-updater/plugin-core";

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
 * The most ops one atomic write sends: one `batch` of at most two statements
 * an op besides its three own, so at most 903 statements. A Worker counts a
 * batch as one query against its invocation's queries, whatever statements
 * it holds (D1's limits), so this bounds one batch, not an invocation: a
 * partitioned release catalog too big for it stages its rows in several
 * writes.
 */
export const D1_MAX_OPS = 450;

/**
 * The queries one Worker invocation may send through a D1 binding on the
 * Free plan, the lower of Cloudflare's two (50 Free, 1,000 Paid; a batch is
 * one query: https://developers.cloudflare.com/d1/platform/limits/). A
 * Worker can't tell its plan, so the binding declares this one.
 */
export const D1_BINDING_QUERIES_PER_REQUEST = 50;

/**
 * Hot Updater's database on D1: the storage engine through the shared SQL
 * core, fenced by the schema settings. D1 has no interactive transactions,
 * so each write is one atomic batch that evaluates its guards first
 * (`_hu_write`).
 */
export const createD1Database = (
  runner: {
    query(statement: SqlStatement): Promise<SqlResult>;
    batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
  },
  {
    maxQueriesPerRequest,
  }: {
    /** A Worker binding's per-invocation query cap; REST has none. */
    readonly maxQueriesPerRequest?: number;
  } = {},
): ToolingDatabase => {
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
  return createEngineDatabase({
    name: "d1Database",
    adapter: Object.assign(
      createSqlAdapter({ executor, maxOps: D1_MAX_OPS, maxParams: 100 }),
      maxQueriesPerRequest === undefined ? {} : { maxQueriesPerRequest },
    ),
  });
};
