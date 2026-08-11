import { createDatabasePlugin } from "@hot-updater/plugin-core";

import { createD1Implementation } from "./d1Implementation";
import { createD1UniversalComponentDataAdapter } from "./d1UniversalComponentData";

type D1Result = {
  readonly results?: readonly unknown[];
};

type D1BoundStatement = {
  all: () => Promise<D1Result>;
};

type D1PreparedStatement<TStatement extends D1BoundStatement> = {
  bind: (...values: readonly unknown[]) => TStatement;
};

export type D1Like<TStatement extends D1BoundStatement = D1BoundStatement> = {
  batch: (statements: TStatement[]) => Promise<readonly D1Result[]>;
  prepare: (sql: string) => D1PreparedStatement<TStatement>;
};

export interface CloudflareWorkerDatabaseEnv {
  readonly DB: D1Database;
}

export const d1WorkerDatabase = <TStatement extends D1BoundStatement>(
  db: D1Like<TStatement>,
) => {
  const executor = {
    async batch(
      statements: readonly {
        readonly params: readonly string[];
        readonly sql: string;
      }[],
    ) {
      const results = await db.batch(
        statements.map(({ params, sql }) => db.prepare(sql).bind(...params)),
      );
      return results.map(({ results }) => results ?? []);
    },
    async query(sql: string, params: readonly string[]) {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all();
      return result.results ?? [];
    },
  };
  const plugin = createDatabasePlugin({
    name: "d1WorkerDatabase",
    plugin: () => createD1Implementation(executor),
  });
  return {
    ...plugin,
    componentData: createD1UniversalComponentDataAdapter(executor),
  };
};
