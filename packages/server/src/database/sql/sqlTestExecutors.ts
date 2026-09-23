import type { DatabaseSync, SqliteValue } from "node:sqlite";

import type { PGlite } from "@electric-sql/pglite";
import type { Pool as MysqlPool, PoolConnection } from "mysql2/promise";
import type { Pool as PgPool, PoolClient } from "pg";

import type {
  SqlConnection,
  SqlExecutor,
  SqlResult,
  SqlStatement,
} from "./sqlAdapter";

/** Test executors for the SQL core; provider executors arrive with D1–D3. */

export const pgliteExecutor = (db: PGlite): SqlExecutor => {
  const over = (runner: Pick<PGlite, "query">): SqlConnection => ({
    execute: async ({ sql, params }) => {
      const result = await runner.query<Record<string, unknown>>(sql, [
        ...params,
      ]);
      return { rows: result.rows, changes: result.affectedRows ?? 0 };
    },
  });
  return {
    dialect: "postgresql",
    ...over(db),
    transaction: (fn) => db.transaction((tx) => fn(over(tx))),
  };
};

/** One connection, so statements and transactions run one at a time. */
export const sqliteExecutor = (db: DatabaseSync): SqlExecutor => {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };
  const execute = async ({ sql, params }: SqlStatement): Promise<SqlResult> => {
    const statement = db.prepare(sql);
    const values = params as SqliteValue[];
    if (statement.columns().length > 0) {
      return { rows: statement.all(...values), changes: 0 };
    }
    return { rows: [], changes: Number(statement.run(...values).changes) };
  };
  return {
    dialect: "sqlite",
    execute: (statement) => serial(() => execute(statement)),
    transaction: (fn) =>
      serial(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn({ execute });
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
  };
};

/**
 * An executor without interactive transactions, as D1's: writes run as one
 * atomic batch, here in a SQLite transaction that rolls back on any error.
 */
export const sqliteBatchExecutor = (db: DatabaseSync): SqlExecutor => {
  const executor = sqliteExecutor(db);
  return {
    dialect: "sqlite",
    execute: executor.execute,
    transaction: () => {
      throw new Error("A batch executor has no interactive transactions.");
    },
    batch: (statements) =>
      executor.transaction(async (connection) => {
        const results: SqlResult[] = [];
        for (const statement of statements) {
          results.push(await connection.execute(statement));
        }
        return results;
      }),
  };
};

/** PGlite without interactive transactions, as an RPC applying a batch would be. */
export const pgliteBatchExecutor = (db: PGlite): SqlExecutor => {
  const executor = pgliteExecutor(db);
  return {
    dialect: "postgresql",
    execute: executor.execute,
    transaction: () => {
      throw new Error("A batch executor has no interactive transactions.");
    },
    batch: (statements) =>
      executor.transaction(async (connection) => {
        const results: SqlResult[] = [];
        for (const statement of statements) {
          results.push(await connection.execute(statement));
        }
        return results;
      }),
  };
};

export const pgExecutor = (pool: PgPool): SqlExecutor => {
  const over = (runner: PgPool | PoolClient): SqlConnection => ({
    execute: async ({ sql, params }) => {
      const result = await runner.query(sql, [...params]);
      return { rows: result.rows, changes: result.rowCount ?? 0 };
    },
  });
  return {
    dialect: "postgresql",
    ...over(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(over(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
};

/** A pooled PostgreSQL batch: one READ COMMITTED transaction per write, as Supabase's apply RPC runs. */
export const pgBatchExecutor = (pool: PgPool): SqlExecutor => {
  const executor = pgExecutor(pool);
  return {
    dialect: "postgresql",
    execute: executor.execute,
    transaction: () => {
      throw new Error("A batch executor has no interactive transactions.");
    },
    batch: (statements) =>
      executor.transaction(async (connection) => {
        const results: SqlResult[] = [];
        for (const statement of statements) {
          results.push(await connection.execute(statement));
        }
        return results;
      }),
  };
};

export const mysqlExecutor = (pool: MysqlPool): SqlExecutor => {
  const over = (runner: MysqlPool | PoolConnection): SqlConnection => ({
    execute: async ({ sql, params }) => {
      const [result] = await runner.query(sql, [...params]);
      return Array.isArray(result)
        ? { rows: result as Record<string, unknown>[], changes: 0 }
        : { rows: [], changes: result.affectedRows };
    },
  });
  return {
    dialect: "mysql",
    ...over(pool),
    async transaction(fn) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await fn(over(connection));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
  };
};
