import type { HotUpdaterContext } from "@hot-updater/plugin-core";
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
import { getDatabaseAdapterUpdateInfo } from "./databaseAdapterUpdateInfo";
import { fromStoredBundleRow } from "./databaseAdapterUtils";
import {
  createKyselyCrud,
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
): DatabasePluginImplementation<HotUpdaterContext<TContext>> => {
  const db = config.db;
  const crud = createKyselyCrud(db, config.provider);
  return {
    ...crud,
    getUpdateInfo: (args, context) =>
      getDatabaseAdapterUpdateInfo(
        {
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
          callback(createKyselyCrud(transaction, config.provider)),
        ),
  };
};

export const kyselyAdapter = <TDatabase extends object, TContext = unknown>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabaseAdapterWithCapabilities<HotUpdaterContext<TContext>> => {
  const provider = createDatabasePlugin<
    KyselyAdapterConfig<TDatabase>,
    HotUpdaterContext<TContext>
  >({
    name: "kysely",
    factory: createImplementation,
  });
  return Object.assign(provider(config), {
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
