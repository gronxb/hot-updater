import type { HotUpdaterContext } from "@hot-updater/plugin-core";
import {
  createDatabaseAdapter,
  type DatabaseAdapterImplementation,
} from "@hot-updater/plugin-core";
import type { Kysely } from "kysely";

import { createKyselyMigrator } from "../db/fixedMigrator";
import type {
  DatabaseAdapterWithCapabilities,
  ORMSQLProvider,
  RelationMode,
} from "../db/types";
import { getDatabaseAdapterUpdateInfo } from "./databaseAdapterUpdateInfo";
import { fromStoredBundleRow } from "./databaseAdapterUtils";
import {
  createKyselyCrud,
  findKyselyChannel,
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

const createImplementation = <TDatabase extends object, TContext>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabaseAdapterImplementation<HotUpdaterContext<TContext>> => {
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
    getUpdateInfo: (args, context) =>
      getDatabaseAdapterUpdateInfo(
        {
          findChannel: (name) => findKyselyChannel(db, config.provider, name),
          findBundles: async (where) =>
            (await findKyselyBundles(db, config.provider, where)).map(
              fromStoredBundleRow,
            ),
          findPatches: (bundleIds) => findKyselyPatches(db, bundleIds),
        },
        args,
        context,
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

export const kyselyAdapter = <TDatabase extends object, TContext = unknown>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabaseAdapterWithCapabilities<HotUpdaterContext<TContext>> => {
  const adapter = createDatabaseAdapter({
    name: "kysely",
    supportsBundleEvents: true,
    adapter: (): DatabaseAdapterImplementation<HotUpdaterContext<TContext>> =>
      createImplementation<TDatabase, TContext>(config),
  });
  return Object.assign(adapter, {
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
