import { createDatabasePlugin } from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";

import { createD1Implementation } from "./d1Implementation";

export interface D1DatabaseConfig {
  readonly databaseId: string;
  readonly accountId: string;
  readonly cloudflareApiToken: string;
}

export const d1Database = (config: D1DatabaseConfig) =>
  createDatabasePlugin({
    name: "d1Database",
    plugin: () => {
      const cloudflare = new Cloudflare({
        apiToken: config.cloudflareApiToken,
      });

      return createD1Implementation({
        async query(sql, params) {
          const page = await cloudflare.d1.database.query(config.databaseId, {
            account_id: config.accountId,
            sql,
            params: [...params],
          });
          const rows: unknown[] = [];
          for await (const resultPage of page.iterPages()) {
            for (const result of resultPage.result) {
              rows.push(...(result.results ?? []));
            }
          }
          return rows;
        },
      });
    },
  });
