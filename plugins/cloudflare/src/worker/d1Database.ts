import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";

import { createD1Implementation, type D1Executor } from "../d1Implementation";
import { createD1InsightsMaintenance } from "../d1InsightsJobs";
import {
  assertD1InsightsDatabaseNamespace,
  createD1InsightsSourceTools,
  verifyD1InsightsDatabaseNamespace,
} from "../d1InsightsSource";

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
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1BoundStatement[]): Promise<readonly D1Result[]>;
};

export interface CloudflareWorkerDatabaseEnv {
  readonly DB: D1Like;
  readonly INSIGHTS_DATABASE_NAMESPACE: string;
}

export interface D1DatabaseConfig {
  readonly database: D1Like;
  readonly insightsDatabaseNamespace: string;
}

export const d1Database = (config: D1DatabaseConfig) => {
  assertD1InsightsDatabaseNamespace(config.insightsDatabaseNamespace);
  const executor: D1Executor = {
    async query(sql, params) {
      const result = await config.database
        .prepare(sql)
        .bind(...params)
        .all();
      return result.results ?? [];
    },
    async batch(statements) {
      const results = await config.database.batch(
        statements.map(({ sql, params }) =>
          config.database.prepare(sql).bind(...params),
        ),
      );
      return results.map(({ results }) => results ?? []);
    },
  };
  const implementation = createD1Implementation(
    executor,
    config.insightsDatabaseNamespace,
  );
  const adapter = createDatabasePluginAdapter("d1Database", implementation);
  const database = createDatabasePlugin({
    name: "d1Database",
    models: adapter.models,
    commit: adapter.commit,
    ...(adapter.dispose ? { dispose: adapter.dispose } : {}),
  });
  const jobs = createD1InsightsMaintenance(
    executor,
    config.insightsDatabaseNamespace,
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
              config.insightsDatabaseNamespace,
            );
            return source.backfillStep(limit);
          },
          async recoverFailedPreparation() {
            await verifyD1InsightsDatabaseNamespace(
              executor,
              config.insightsDatabaseNamespace,
            );
            return source.recoverFailedPreparation();
          },
        },
      },
    },
  };
};
