import { createDatabasePlugin } from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";

import { createD1Implementation, type D1Statement } from "./d1Implementation";
import { createD1UniversalComponentDataAdapter } from "./d1UniversalComponentData";

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
  const executor = {
    async query(sql: string, params: readonly string[]) {
      return (await execute([{ sql, params }])).flat();
    },
    batch: execute,
  };
  const plugin = createDatabasePlugin({
    name: "d1Database",
    plugin: () => createD1Implementation(executor),
  });
  return {
    ...plugin,
    componentData: createD1UniversalComponentDataAdapter(executor),
  };
};
