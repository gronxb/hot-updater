import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import type { Kysely } from "kysely";

import { createKyselyMigrator } from "../db/fixedMigrator";
import type {
  DatabaseAdapterWithCapabilities,
  ORMSQLProvider,
  RelationMode,
} from "../db/types";
import { createKyselyCrud, recordKyselyInsights } from "./kyselyCrud";
import {
  getKyselyAppUsage,
  getKyselyReleaseActivity,
} from "./kyselyInsightsOverview";

type KyselySQLProvider = Exclude<ORMSQLProvider, "mssql">;

export type { RelationMode, KyselySQLProvider as SQLProvider };

export interface KyselyAdapterConfig<TDatabase extends object = object> {
  readonly db: Kysely<TDatabase>;
  readonly provider: KyselySQLProvider;
  readonly relationMode?: RelationMode;
}

const createImplementation = <TDatabase extends object>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabasePluginImplementation => {
  const db = config.db;
  const relationMode = config.relationMode ?? "foreign-keys";
  const crud = createKyselyCrud(db, config.provider, relationMode);
  return {
    ...crud,
    recordInsights: (input) =>
      db
        .transaction()
        .execute((transaction) =>
          recordKyselyInsights(transaction, config.provider, input),
        ),
    getReleaseActivity: (input) => getKyselyReleaseActivity(db, input),
    getAppUsage: (input) => getKyselyAppUsage(db, input),
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
    transaction: async (callback) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const transaction = db.transaction();
          // Expectations and writes must share a serializable snapshot. A
          // retried loser then observes the winner's revision/generation.
          const isolated =
            config.provider === "sqlite"
              ? transaction
              : transaction.setIsolationLevel("serializable");
          return await isolated.execute((transaction) =>
            callback(
              createKyselyCrud(transaction, config.provider, relationMode),
            ),
          );
        } catch (error) {
          if (
            attempt >= 15 ||
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            !["40001", "40P01", "ER_LOCK_DEADLOCK"].includes(String(error.code))
          )
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(2 ** attempt, 32)),
          );
        }
      }
    },
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
    createMigrator: () =>
      createKyselyMigrator({
        db: config.db,
        provider: config.provider,
        relationMode: config.relationMode,
      }),
  });
};
