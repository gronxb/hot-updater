import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import type { Kysely } from "kysely";

import { createKyselyMigrator } from "../db/fixedMigrator";
import type {
  DatabaseAdapterWithCapabilities,
  MigrationResult,
  ORMSQLProvider,
  RelationMode,
} from "../db/types";
import { createKyselyCrud } from "./kyselyCrud";
import {
  createKyselyInsightsModel,
  getKyselyInsightsDDL,
  migrateKyselyInsights,
} from "./sqlInsights/kysely";

export { runKyselyInsightsMaintenanceStep } from "./sqlInsights/kysely";

type KyselySQLProvider = Exclude<ORMSQLProvider, "mssql">;

export type { RelationMode, KyselySQLProvider as SQLProvider };

export interface KyselyAdapterConfig<TDatabase extends object = object> {
  readonly db: Kysely<TDatabase>;
  readonly provider: KyselySQLProvider;
  readonly relationMode?: RelationMode;
}

const extendMigration = <TDatabase extends object>(
  result: MigrationResult,
  config: KyselyAdapterConfig<TDatabase>,
): MigrationResult => {
  const statements = getKyselyInsightsDDL(
    config.provider,
    OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
  );
  return {
    operations: [
      ...result.operations,
      ...statements.map((statement) => ({
        type: "custom" as const,
        sql: statement,
      })),
    ],
    getSQL: () =>
      [result.getSQL?.(), ...statements.map((statement) => `${statement};`)]
        .filter(Boolean)
        .join("\n\n"),
    execute: async () => {
      await result.execute();
      await migrateKyselyInsights(
        config.db,
        config.provider,
        OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
        statements,
      );
    },
  };
};

const createImplementation = <TDatabase extends object>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabasePluginImplementation => {
  const db = config.db;
  const relationMode = config.relationMode ?? "foreign-keys";
  const crud = createKyselyCrud(db, config.provider, relationMode);
  return {
    ...crud,
    insights: createKyselyInsightsModel(
      db,
      config.provider,
      OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
    ),
    deleteChannel: (input) =>
      db
        .transaction()
        .execute((transaction) =>
          createKyselyCrud(
            transaction,
            config.provider,
            relationMode,
          ).deleteChannel(input),
        ),
    create: (input) =>
      db
        .transaction()
        .execute((transaction) =>
          createKyselyCrud(transaction, config.provider, relationMode).create(
            input,
          ),
        ),
    update: (input) =>
      db
        .transaction()
        .execute((transaction) =>
          createKyselyCrud(transaction, config.provider, relationMode).update(
            input,
          ),
        ),
    delete: (input) =>
      db
        .transaction()
        .execute((transaction) =>
          createKyselyCrud(transaction, config.provider, relationMode).delete(
            input,
          ),
        ),
    transaction: (callback) =>
      db
        .transaction()
        .execute((transaction) =>
          callback(
            createKyselyCrud(transaction, config.provider, relationMode),
          ),
        ),
  };
};

export const kyselyAdapter = <TDatabase extends object>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabaseAdapterWithCapabilities => {
  const adapter = createDatabasePluginAdapter(
    "kysely",
    createImplementation<TDatabase>(config),
  );
  const plugin = createDatabasePlugin({
    name: "kysely",
    models: adapter.models,
    commit: adapter.commit,
  });
  return Object.assign(plugin, {
    adapterName: "kysely",
    provider: config.provider,
    createMigrator: () => {
      const migrator = createKyselyMigrator({
        db: config.db,
        provider: config.provider,
        relationMode: config.relationMode,
      });
      return {
        ...migrator,
        up: async (options: Parameters<typeof migrator.up>[0]) =>
          extendMigration(await migrator.up(options), config),
        migrateTo: async (
          version: Parameters<typeof migrator.migrateTo>[0],
          options: Parameters<typeof migrator.migrateTo>[1],
        ) =>
          extendMigration(await migrator.migrateTo(version, options), config),
        migrateToLatest: async (
          options: Parameters<typeof migrator.migrateToLatest>[0],
        ) => extendMigration(await migrator.migrateToLatest(options), config),
      };
    },
  });
};
