import type { DatabasePlugin } from "@hot-updater/plugin-core";

import {
  createD1DatabasePlugin,
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

export interface CloudflareWorkerDatabaseEnv {
  readonly DB: D1Like;
}

/** Hot Updater's database on a D1 binding, inside a Worker. */
export const d1Database = (database: D1Like): DatabasePlugin =>
  createD1DatabasePlugin({
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
  });
