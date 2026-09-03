import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
} from "@hot-updater/plugin-core/internal";
import Cloudflare from "cloudflare";

import {
  createD1Implementation,
  type D1Executor,
  type D1Statement,
} from "./d1Implementation";
import { createD1InsightsMaintenance } from "./d1InsightsJobs";
import {
  assertD1InsightsDatabaseNamespace,
  createD1InsightsSourceTools,
  verifyD1InsightsDatabaseNamespace,
} from "./d1InsightsSource";

export interface D1DatabaseConfig {
  readonly databaseId: string;
  readonly accountId: string;
  readonly cloudflareApiToken: string;
}

export const d1Database = (config: D1DatabaseConfig) => {
  assertD1InsightsDatabaseNamespace(OFFICIAL_INSIGHTS_DATABASE_NAMESPACE);
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
        results.push(result.results ?? []);
      }
    }
    return results;
  };

  const executor: D1Executor = {
    async query(sql, params) {
      return (await execute([{ sql, params }])).flat();
    },
    batch: execute,
  };
  const adapter = createDatabasePluginAdapter(
    "d1Database",
    createD1Implementation(executor, OFFICIAL_INSIGHTS_DATABASE_NAMESPACE),
  );
  const database = createDatabasePlugin({
    name: "d1Database",
    models: adapter.models,
    commit: adapter.commit,
    ...(adapter.dispose ? { dispose: adapter.dispose } : {}),
  });
  const jobs = createD1InsightsMaintenance(
    executor,
    OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
  );
  const source = createD1InsightsSourceTools(executor);
  return {
    ...database,
    models: {
      ...database.models,
      insights: {
        ...database.models.insights,
        maintenance: {
          runStep: jobs.runStep,
          async backfillStep(limit: number) {
            await verifyD1InsightsDatabaseNamespace(
              executor,
              OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
            );
            return source.backfillStep(limit);
          },
          async recoverFailedPreparation() {
            await verifyD1InsightsDatabaseNamespace(
              executor,
              OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
            );
            return source.recoverFailedPreparation();
          },
        },
      },
    },
  };
};
