import { attachAnalyticsProviderCapability } from "@hot-updater/analytics/internal/provider-capability";
import {
  createBoundedAnalyticsProvider,
  type AnalyticsMigrationResult,
} from "@hot-updater/analytics/provider";
import {
  createDatabasePlugin,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import Cloudflare from "cloudflare";

import { runD1AnalyticsMigration } from "./d1AnalyticsMigration";
import { createD1AnalyticsPersistence } from "./d1AnalyticsPersistence";
import { createD1Implementation } from "./d1Implementation";
import type { D1Executor } from "./d1Implementation";

export interface D1DatabaseConfig {
  readonly databaseId: string;
  readonly accountId: string;
  readonly cloudflareApiToken: string;
}

function createD1Executor(config: D1DatabaseConfig): D1Executor {
  const cloudflare = new Cloudflare({
    apiToken: config.cloudflareApiToken,
  });
  return {
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
  };
}

export const d1Database = (config: D1DatabaseConfig): DatabasePlugin => {
  const executor = createD1Executor(config);
  return attachAnalyticsProviderCapability(
    createDatabasePlugin({
      name: "d1Database",
      plugin: () => createD1Implementation(executor),
    }),
    () =>
      createBoundedAnalyticsProvider(createD1AnalyticsPersistence(executor)),
  );
};

export const migrateD1Analytics = (
  config: D1DatabaseConfig,
): Promise<AnalyticsMigrationResult> => {
  const executor = createD1Executor(config);
  return runD1AnalyticsMigration({
    ...executor,
    async batch(statements) {
      await executor.query(statements.join(";\n"), []);
    },
  });
};
