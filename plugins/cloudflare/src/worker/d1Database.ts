import type { EngineDatabase } from "@hot-updater/plugin-core";

import {
  createD1Database,
  D1_BINDING_QUERIES_PER_REQUEST,
  D1ExecutionError,
  type D1ResultLike,
  toSqlResult,
} from "../d1Executor";

type D1BoundStatement = {
  all: () => Promise<D1ResultLike>;
};

type D1PreparedStatement = {
  bind: (...values: readonly unknown[]) => D1BoundStatement;
};

export type D1Like = {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1BoundStatement[]): Promise<readonly D1ResultLike[]>;
};

/**
 * Hot Updater's database on a D1 binding, inside a Worker, which declares
 * the Free plan's 50 queries per invocation as its query cap.
 */
export const d1Database = (database: D1Like): EngineDatabase =>
  createD1Database(
    {
      query: async ({ sql, params }) =>
        toSqlResult(
          await database
            .prepare(sql)
            .bind(...params)
            .all(),
        ),
      async batch(statements) {
        const results = await database.batch(
          statements.map(({ sql, params }) =>
            database.prepare(sql).bind(...params),
          ),
        );
        if (results.length !== statements.length) throw new D1ExecutionError();
        return results.map(toSqlResult);
      },
    },
    { maxQueriesPerRequest: D1_BINDING_QUERIES_PER_REQUEST },
  );
