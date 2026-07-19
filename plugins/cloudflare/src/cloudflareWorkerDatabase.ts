import { createDatabaseAdapter } from "@hot-updater/plugin-core";

import { createD1Implementation } from "./d1Implementation";

type D1Result = {
  readonly results?: readonly unknown[];
};

type D1BoundStatement = {
  all: () => Promise<D1Result>;
};

type D1PreparedStatement = {
  bind: (...values: readonly unknown[]) => D1BoundStatement;
};

export type D1Like = {
  prepare: (sql: string) => D1PreparedStatement;
};

export interface CloudflareWorkerDatabaseEnv {
  readonly DB: D1Like;
}

export const d1WorkerDatabase = (db: D1Like) =>
  createDatabaseAdapter({
    name: "d1WorkerDatabase",
    adapter: () =>
      createD1Implementation({
        async query(sql, params) {
          const result = await db
            .prepare(sql)
            .bind(...params)
            .all();
          return result.results ?? [];
        },
      }),
  });
