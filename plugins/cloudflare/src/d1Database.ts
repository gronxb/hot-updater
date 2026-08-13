import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";
import Cloudflare from "cloudflare";

import { createD1Implementation, type D1Statement } from "./d1Implementation";

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
    const page = await cloudflare.d1.database.query(config.databaseId, {
      account_id: config.accountId,
      sql: statements.map(({ sql }) => sql).join("; "),
      params: statements.flatMap(({ params }) => [...params]),
    });
    const results: unknown[][] = [];
    for await (const resultPage of page.iterPages()) {
      for (const result of resultPage.result) {
        results.push(result.results ?? []);
      }
    }
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
