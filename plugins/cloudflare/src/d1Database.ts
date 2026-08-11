import {
  attachUniversalComponentDataAdapter,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";

import { createD1Implementation } from "./d1Implementation";
import type { D1Executor } from "./d1Implementation";
import { createD1UniversalComponentDataAdapter } from "./d1UniversalComponentData";

export interface D1DatabaseConfig {
  readonly databaseId: string;
  readonly accountId: string;
  readonly cloudflareApiToken: string;
}

const createD1Executor = (config: D1DatabaseConfig): D1Executor => {
  const cloudflare = new Cloudflare({
    apiToken: config.cloudflareApiToken,
  });
  return {
    async batch(
      statements: readonly {
        readonly params: readonly string[];
        readonly sql: string;
      }[],
    ) {
      if (statements.length === 0) return;
      if (statements.some(({ params }) => params.length !== 0)) {
        throw new TypeError(
          "Remote D1 batch only supports parameter-free migration statements",
        );
      }
      await cloudflare.d1.database.query(config.databaseId, {
        account_id: config.accountId,
        params: [],
        sql: statements.map(({ sql }) => sql).join(";\n"),
      });
    },
    async query(sql: string, params: readonly string[]) {
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
  };
};

export const d1Database = (config: D1DatabaseConfig) => {
  const executor = createD1Executor(config);
  return attachUniversalComponentDataAdapter(
    createDatabasePlugin({
      name: "d1Database",
      plugin: () => createD1Implementation(executor),
    }),
    () => createD1UniversalComponentDataAdapter(executor),
  );
};
