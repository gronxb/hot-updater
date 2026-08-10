import { attachAnalyticsProviderCapability } from "@hot-updater/analytics/internal/provider-capability";
import { createBoundedAnalyticsProvider } from "@hot-updater/analytics/provider";
import { attachManagedAccessKeyStore } from "@hot-updater/better-auth/managed";
import { createDatabasePlugin } from "@hot-updater/plugin-core";

import { runD1AnalyticsMigration } from "./d1AnalyticsMigration";
import { createD1AnalyticsPersistence } from "./d1AnalyticsPersistence";
import { createD1Implementation } from "./d1Implementation";
import type { D1Executor } from "./d1Implementation";
import { createD1ManagedAccessKeyStoreFromExecutor } from "./d1ManagedAccessKeyStore";

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

const createD1WorkerExecutor = (db: D1Like): D1Executor => ({
  async query(sql, params) {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .all();
    return result.results ?? [];
  },
});

export const d1WorkerDatabase = (db: D1Like) => {
  const executor = createD1WorkerExecutor(db);
  return attachManagedAccessKeyStore(
    attachAnalyticsProviderCapability(
      createDatabasePlugin({
        name: "d1WorkerDatabase",
        plugin: () => createD1Implementation(executor),
      }),
      () =>
        createBoundedAnalyticsProvider(createD1AnalyticsPersistence(executor)),
    ),
    () => createD1ManagedAccessKeyStoreFromExecutor(executor),
  );
};

export const migrateD1WorkerAnalytics = (db: D1Database) => {
  const executor = createD1WorkerExecutor(db);
  return runD1AnalyticsMigration({
    ...executor,
    async batch(statements) {
      await db.batch(statements.map((statement) => db.prepare(statement)));
    },
  });
};
