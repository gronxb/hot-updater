import { CompiledQuery, type Kysely, type QueryResult } from "kysely";

import type {
  SqlConnection,
  SqlDialect,
  SqlExecutor,
} from "../database/sql/sqlAdapter";

interface QueryRunner {
  executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>>;
}

const over = (runner: QueryRunner): SqlConnection => ({
  async execute({ sql, params }) {
    const result = await runner.executeQuery<Record<string, unknown>>(
      CompiledQuery.raw(sql, [...params]),
    );
    return {
      rows: result.rows,
      changes: Number(result.numAffectedRows ?? 0n),
    };
  },
});

const raw = (runner: QueryRunner, sql: string) =>
  runner.executeQuery(CompiledQuery.raw(sql));

/**
 * The SQL core's executor over a Kysely instance: statements run as raw
 * compiled queries. SQLite transactions begin with BEGIN IMMEDIATE on one
 * connection; other dialects use Kysely's transactions.
 */
export const kyselyExecutor = (
  db: Kysely<object>,
  dialect: SqlDialect,
): SqlExecutor => ({
  dialect,
  ...over(db),
  transaction: (fn) =>
    dialect === "sqlite"
      ? db.connection().execute(async (connection) => {
          await raw(connection, "BEGIN IMMEDIATE");
          try {
            const result = await fn(over(connection));
            await raw(connection, "COMMIT");
            return result;
          } catch (error) {
            await raw(connection, "ROLLBACK").catch(() => undefined);
            throw error;
          }
        })
      : db.transaction().execute((transaction) => fn(over(transaction))),
});
