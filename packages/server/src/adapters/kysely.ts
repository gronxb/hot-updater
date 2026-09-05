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
import { runInsightsTransaction } from "./insightsTransaction";
import { createKyselyCrud, recordKyselyInsights } from "./kyselyCrud";

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
      runInsightsTransaction(() =>
        db
          .transaction()
          .execute((transaction) =>
            recordKyselyInsights(transaction, config.provider, input),
          ),
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
    createMigrator: () =>
      createKyselyMigrator({
        db: config.db,
        provider: config.provider,
        relationMode: config.relationMode,
      }),
  });
};
