import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
} from "@hot-updater/plugin-core/internal";

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
}

export const d1Database = (database: D1Like) => {
  assertD1InsightsDatabaseNamespace(OFFICIAL_INSIGHTS_DATABASE_NAMESPACE);
  const executor: D1Executor = {
    async query(sql, params) {
      const result = await database
        .prepare(sql)
        .bind(...params)
        .all();
      return result.results ?? [];
    },
    async batch(statements) {
      const results = await database.batch(
        statements.map(({ sql, params }) =>
          database.prepare(sql).bind(...params),
        ),
      );
      return results.map(({ results }) => results ?? []);
    },
  };
  const implementation = createD1Implementation(
    executor,
    OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
  );
  const adapter = createDatabasePluginAdapter("d1Database", implementation);
  const plugin = createDatabasePlugin({
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
    ...plugin,
    models: {
      ...plugin.models,
      insights: {
        ...plugin.models.insights,
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
