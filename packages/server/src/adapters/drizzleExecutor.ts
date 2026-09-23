import { sql, type SQL } from "drizzle-orm";

import type {
  SqlConnection,
  SqlDialect,
  SqlExecutor,
  SqlResult,
  SqlStatement,
} from "../database/sql/sqlAdapter";

/** The members of a Drizzle database or transaction the executor uses. */
interface DrizzleRunner {
  execute?(query: SQL): Promise<unknown>;
  all?(query: SQL): unknown;
  run?(query: SQL): unknown;
  transaction?(fn: (tx: DrizzleRunner) => Promise<unknown>): unknown;
  /** SQLite drivers: `sync` for better-sqlite3 and bun:sqlite. */
  readonly resultKind?: "sync" | "async";
}

export const SUPPORTED_DRIZZLE_DRIVERS =
  "node-postgres, postgres-js, PGlite, or Neon over WebSockets for PostgreSQL; mysql2 for MySQL; libSQL, better-sqlite3, or bun:sqlite for SQLite";

export class DrizzleTransactionUnsupportedError extends Error {
  readonly name = "DrizzleTransactionUnsupportedError";
  constructor(cause: unknown) {
    super(
      `This Drizzle driver cannot run interactive transactions, which Hot Updater needs. Use ${SUPPORTED_DRIZZLE_DRIVERS}.`,
      { cause },
    );
  }
}

/** The SQL core's statement as Drizzle SQL, each placeholder bound as a parameter. */
const toSql = (dialect: SqlDialect, { sql: text, params }: SqlStatement) => {
  const pattern = dialect === "postgresql" ? /\$(\d+)/gu : /\?/gu;
  const chunks: SQL[] = [];
  let last = 0;
  let next = 0;
  for (const match of text.matchAll(pattern)) {
    chunks.push(sql.raw(text.slice(last, match.index)));
    const position = dialect === "postgresql" ? Number(match[1]) - 1 : next++;
    chunks.push(sql`${sql.param(params[position])}`);
    last = match.index + match[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return sql.join(chunks);
};

const over = (dialect: SqlDialect, runner: DrizzleRunner): SqlConnection => ({
  async execute(statement): Promise<SqlResult> {
    const query = toSql(dialect, statement);
    if (dialect === "sqlite") {
      return /^\s*SELECT\b/iu.test(statement.sql)
        ? {
            rows: (await runner.all!(query)) as Record<string, unknown>[],
            changes: 0,
          }
        : { rows: [], changes: changesOf(await runner.run!(query)) };
    }
    const result = await runner.execute!(query);
    // mysql2 answers [rows or header, fields]; postgres-js answers the rows.
    const value =
      dialect === "mysql" && Array.isArray(result) ? result[0] : result;
    const rows = Array.isArray(value)
      ? value
      : ((value as { rows?: unknown[] }).rows ?? []);
    return {
      rows: rows as Record<string, unknown>[],
      changes:
        Array.isArray(value) && dialect === "mysql" ? 0 : changesOf(value),
    };
  },
});

const changesOf = (result: unknown): number => {
  const record = (result ?? {}) as Record<string, unknown>;
  const meta = record.meta as Record<string, unknown> | undefined;
  return Number(
    record.rowCount ??
      record.affectedRows ??
      record.rowsAffected ??
      record.changes ??
      record.count ??
      meta?.changes ??
      0,
  );
};

/**
 * The SQL core's executor over a Drizzle database, or a function that
 * returns one. Async drivers run Drizzle's transactions; sync SQLite drivers
 * run one statement at a time, beginning transactions with BEGIN IMMEDIATE.
 * First use checks that the driver can run a transaction at all.
 */
export const drizzleExecutor = (
  source: unknown,
  dialect: SqlDialect,
): SqlExecutor => {
  const isSync = (runner: DrizzleRunner) =>
    dialect === "sqlite" && runner.resultKind === "sync";
  let ready: Promise<DrizzleRunner> | undefined;
  const resolve = () => {
    ready ??= (async () => {
      const runner = (await (typeof source === "function"
        ? (source as () => unknown)()
        : source)) as DrizzleRunner;
      if (isSync(runner)) return runner;
      let started = false;
      try {
        if (typeof runner.transaction !== "function") {
          throw new TypeError("The Drizzle database has no transaction().");
        }
        await runner.transaction(async () => {
          started = true;
        });
      } catch (error) {
        if (!started) throw new DrizzleTransactionUnsupportedError(error);
        throw error;
      }
      return runner;
    })();
    // A failed check runs again next time.
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  };
  // Sync drivers share one connection: nothing may interleave a transaction.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>) => {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  };
  return {
    dialect,
    async execute(statement) {
      const runner = await resolve();
      const run = () => over(dialect, runner).execute(statement);
      return isSync(runner) ? serial(run) : run();
    },
    async transaction(fn) {
      const runner = await resolve();
      if (!isSync(runner)) {
        return (await runner.transaction!((tx) =>
          fn(over(dialect, tx)),
        )) as Awaited<ReturnType<typeof fn>>;
      }
      return serial(async () => {
        const connection = over(dialect, runner);
        const raw = (text: string) =>
          connection.execute({ sql: text, params: [] });
        await raw("BEGIN IMMEDIATE");
        try {
          const result = await fn(connection);
          await raw("COMMIT");
          return result;
        } catch (error) {
          await raw("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
    },
  };
};
