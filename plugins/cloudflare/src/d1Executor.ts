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
 * The D1 errors Cloudflare's D1 guide says to retry ("Retry the operation"):
 * a dropped connection, a reset or restarted database object, a transient
 * failure to reach its node, and a replica cut off from its primary.
 */
const TRANSIENT_D1_ERROR =
  /Network connection lost|storage caused object to be reset|reset because its code was updated|Cannot resolve D1 DB due to transient issue|Replica disconnected from primary/iu;

/** The SQL core's reads, the only statements a retry can't apply twice. */
const READ_ONLY_STATEMENT = /^\s*SELECT\b/iu;

/** Attempts of a read in all, the first included. */
const READ_ATTEMPTS = 3;
/** The longest wait before the second attempt, doubling after it, with full jitter. */
const READ_RETRY_BASE_MS = 25;

const isTransient = (error: unknown) =>
  TRANSIENT_D1_ERROR.test(
    error instanceof Error ? error.message : String(error),
  );

/**
 * Runs a read again when D1 failed it with a transient error, at most
 * {@link READ_ATTEMPTS} times, and throws the last error. D1 retries a
 * read-only query twice on its own; an error that outlasts those retries
 * still answers a request with 500, where one more attempt after a short
 * wait usually reads. A write may have committed when it fails, so it never
 * runs again.
 */
export const retryingReads =
  (query: (statement: SqlStatement) => Promise<SqlResult>) =>
  async (statement: SqlStatement): Promise<SqlResult> => {
    if (!READ_ONLY_STATEMENT.test(statement.sql)) return query(statement);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await query(statement);
      } catch (error) {
        if (attempt >= READ_ATTEMPTS || !isTransient(error)) throw error;
        const wait = Math.random() * READ_RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };

/**
 * The most ops one write sends: one `batch` of at most two statements an op
 * besides its three own, so at most 903 statements. A Worker counts a batch
 * as one query against its invocation's queries, whatever statements it
 * holds (D1's limits), so this bounds one batch, not an invocation.
 */
export const D1_MAX_OPS = 450;

/**
 * Hot Updater's database on D1: the storage engine through the shared SQL
 * core, fenced by the schema settings. D1 has no interactive transactions,
 * so each write is one atomic batch that evaluates its guards first
 * (`_hu_write`).
 */
export const createD1Database = (runner: {
  query(statement: SqlStatement): Promise<SqlResult>;
  batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
}): ToolingDatabase => {
  const query = retryingReads((statement) => runner.query(statement));
  const executor: SqlExecutor = {
    dialect: "sqlite",
    execute: (statement) =>
      query(statement).catch((error: unknown) => {
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
    adapter: createSqlAdapter({ executor, maxOps: D1_MAX_OPS, maxParams: 100 }),
  });
};
