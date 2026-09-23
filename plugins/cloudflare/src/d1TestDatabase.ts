import { DatabaseSync, type SqliteValue } from "node:sqlite";

import {
  createTableStatements,
  legacyFacadeSchema,
  legacyFacadeSettings,
  WRITE_GUARD_TABLE,
} from "@hot-updater/server/database";
import { generateEngineSql } from "@hot-updater/server/db";

import type { D1ResultLike } from "./d1Executor";

/** A migrated D1 database over `node:sqlite`, answering as D1 does. */
export const createD1TestDatabase = () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of [
    ...createTableStatements("sqlite", [WRITE_GUARD_TABLE]),
    ...generateEngineSql("sqlite", legacyFacadeSchema, legacyFacadeSettings),
  ]) {
    db.exec(sql);
  }
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
