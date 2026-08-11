import {
  attachUniversalComponentDataAdapter,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";

import { createD1Implementation } from "./d1Implementation";
import type { D1Executor } from "./d1Implementation";
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

const createD1WorkerExecutor = <TStatement extends D1BoundStatement>(
  db: D1Like<TStatement>,
): D1Executor => ({
  async batch(statements) {
    await db.batch(
      statements.map(({ params, sql }) => db.prepare(sql).bind(...params)),
    );
  },
  async query(sql, params) {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .all();
    return result.results ?? [];
  },
});

export const d1WorkerDatabase = <TStatement extends D1BoundStatement>(
  db: D1Like<TStatement>,
) => {
  const executor = createD1WorkerExecutor(db);
  return attachUniversalComponentDataAdapter(
    createDatabasePlugin({
      name: "d1WorkerDatabase",
      plugin: () => createD1Implementation(executor),
    }),
    () => createD1UniversalComponentDataAdapter(executor),
  );
};
