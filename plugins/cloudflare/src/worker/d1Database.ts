import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";

import { createD1Implementation, D1ExecutionError } from "../d1Implementation";

type D1Result = {
  readonly results?: readonly unknown[];
  readonly success?: boolean;
};

type D1BoundStatement = {
  all: () => Promise<D1Result>;
};

type D1PreparedStatement = {
  bind: (...values: readonly unknown[]) => D1BoundStatement;
};

export type D1Like = {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1BoundStatement[]): Promise<readonly D1Result[]>;
};

export interface CloudflareWorkerDatabaseEnv {
  readonly DB: D1Like;
}

export const d1Database = (database: D1Like) => {
  const implementation = createD1Implementation({
    async query(sql, params) {
      const result = await database
        .prepare(sql)
        .bind(...params)
        .all();
      if (result.success === false) throw new D1ExecutionError();
      return result.results ?? [];
    },
    async batch(statements) {
      const results = await database.batch(
        statements.map(({ sql, params }) =>
          database.prepare(sql).bind(...params),
        ),
      );
      if (
        results.length !== statements.length ||
        results.some(({ success }) => success === false)
      ) {
        throw new D1ExecutionError();
      }
      return results.map(({ results }) => results ?? []);
    },
  });
  const adapter = createDatabasePluginAdapter("d1Database", implementation);
  return createDatabasePlugin({
    name: "d1Database",
    models: adapter.models,
    commit: adapter.commit,
    ...(adapter.dispose ? { dispose: adapter.dispose } : {}),
  });
};
