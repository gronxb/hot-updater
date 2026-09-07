import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";
import Cloudflare from "cloudflare";

import {
  createD1Implementation,
  D1ExecutionError,
  type D1Statement,
} from "./d1Implementation";

export interface D1DatabaseConfig {
  readonly databaseId: string;
  readonly accountId: string;
  readonly cloudflareApiToken: string;
}

export const d1Database = (config: D1DatabaseConfig) => {
  const cloudflare = new Cloudflare({
    apiToken: config.cloudflareApiToken,
  });

  const execute = async (
    statements: readonly D1Statement[],
  ): Promise<readonly (readonly unknown[])[]> => {
    const first = statements[0];
    if (first === undefined) return [];
    const body =
      statements.length === 1
        ? {
            account_id: config.accountId,
            sql: first.sql,
            params: [...first.params],
          }
        : {
            account_id: config.accountId,
            batch: statements.map(({ sql, params }) => ({
              sql,
              params: [...params],
            })),
          };
    // cloudflare@4 predates the D1 REST API's parameterized batch body type.
    const page = await cloudflare.d1.database.query(config.databaseId, {
      ...body,
    } as unknown as Parameters<typeof cloudflare.d1.database.query>[1]);
    const results: unknown[][] = [];
    for await (const resultPage of page.iterPages()) {
      for (const result of resultPage.result) {
        if (result.success === false) throw new D1ExecutionError();
        results.push(result.results ?? []);
      }
    }
    if (results.length !== statements.length) throw new D1ExecutionError();
    return results;
  };

  const adapter = createDatabasePluginAdapter(
    "d1Database",
    createD1Implementation({
      async query(sql, params) {
        return (await execute([{ sql, params }])).flat();
      },
      batch: execute,
    }),
  );
  return createDatabasePlugin({
    name: "d1Database",
    models: adapter.models,
    commit: adapter.commit,
    ...(adapter.dispose ? { dispose: adapter.dispose } : {}),
  });
};
