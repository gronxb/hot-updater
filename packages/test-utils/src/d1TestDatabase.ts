import type { DatabaseSync, SqliteValue } from "node:sqlite";

/** What a D1 statement answers: `results` for a read, `meta.changes` for a write. */
export interface D1TestResult {
  readonly success: true;
  readonly results: readonly unknown[];
  readonly meta: { readonly changes?: number };
}

/**
 * A D1 database over `node:sqlite`, answering as D1 does, after it runs
 * `statements`, such as a provider's schema: what a D1 executor's specs
 * run on without Cloudflare. `db` is a database the spec opens, such as
 * `new DatabaseSync(":memory:")`.
 */
export const createD1TestDatabase = (
  db: DatabaseSync,
  statements: readonly string[] = [],
) => {
  for (const sql of statements) db.exec(sql);
  const run = (sql: string, params: readonly unknown[]): D1TestResult => {
    const statement = db.prepare(sql);
    const values = params as SqliteValue[];
    return statement.columns().length > 0
      ? { success: true, results: statement.all(...values), meta: {} }
      : {
          success: true,
          results: [],
          meta: { changes: Number(statement.run(...values).changes) },
        };
  };
  /** Runs statements atomically, as `batch` does. */
  const batch = (
    statements: readonly { sql: string; params: readonly unknown[] }[],
  ) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(({ sql, params }) => run(sql, params));
      db.exec("COMMIT");
      return results;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return { db, run, batch };
};
