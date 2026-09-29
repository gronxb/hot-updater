import { DatabaseSync, type SqliteValue } from "node:sqlite";

import type { D1ResultLike } from "./d1Executor";
import { d1SchemaStatements } from "./d1Schema";

/** A D1 database over `node:sqlite`, answering as D1 does; migrated unless given other statements. */
export const createD1TestDatabase = (
  statements: readonly string[] = d1SchemaStatements(),
) => {
  const db = new DatabaseSync(":memory:");
  for (const sql of statements) db.exec(sql);
  const run = (sql: string, params: readonly unknown[]): D1ResultLike => {
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
