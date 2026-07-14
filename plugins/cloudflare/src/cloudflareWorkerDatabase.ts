import type { RequestEnvContext } from "@hot-updater/plugin-core";
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

class MissingD1BindingError extends Error {
  readonly name = "MissingD1BindingError";

  constructor() {
    super("MissingD1BindingError");
  }
}

export const d1WorkerDatabase = <
  TContext extends RequestEnvContext<CloudflareWorkerDatabaseEnv> =
    RequestEnvContext<CloudflareWorkerDatabaseEnv>,
>() =>
  createDatabaseAdapter({
    name: "d1WorkerDatabase",
    supportsBundleEvents: true,
    adapter: () =>
      createD1Implementation<TContext>({
        async query(sql, params, context) {
          const db = context?.env?.DB;
          if (db === undefined) throw new MissingD1BindingError();
          const result = await db
            .prepare(sql)
            .bind(...params)
            .all();
          return result.results ?? [];
        },
      }),
  });
