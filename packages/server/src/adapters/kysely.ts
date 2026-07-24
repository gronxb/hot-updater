import {
  createDatabasePlugin,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import type { Kysely } from "kysely";

import { createKyselyMigrator } from "../db/fixedMigrator";
import type {
  DatabaseAdapterWithCapabilities,
  ORMSQLProvider,
  RelationMode,
} from "../db/types";
import { getDatabasePluginUpdateInfo } from "./databasePluginUpdateInfo";
import { fromStoredBundleRow } from "./databasePluginUtils";
import {
  createKyselyCrud,
  findKyselyChannels,
  findKyselyBundles,
  findKyselyPatches,
} from "./kyselyCrud";

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
    getUpdateInfo: (args) =>
      getDatabasePluginUpdateInfo(
        {
          findBundles: async (where) =>
            (await findKyselyBundles(db, config.provider, where)).map(
              fromStoredBundleRow,
            ),
          findPatches: (bundleIds) => findKyselyPatches(db, bundleIds),
        },
        args,
      ),
    getChannels: () => findKyselyChannels(db),
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
  const plugin = createDatabasePlugin({
    name: "kysely",
    plugin: (): DatabasePluginImplementation =>
      createImplementation<TDatabase>(config),
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
