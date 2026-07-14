import type { HotUpdaterContext } from "@hot-updater/plugin-core";
import {
  createDatabaseAdapter,
  type DatabaseAdapterImplementation,
  type TransactionDatabaseAdapterImplementation,
} from "@hot-updater/plugin-core";
import { asc, desc, inArray } from "drizzle-orm";

import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
} from "../db/schema/registry";
import { generateDrizzleSchema } from "../db/schemaGenerators";
import type {
  DatabaseAdapterWithCapabilities,
  ORMProvider,
  SchemaGenerator,
} from "../db/types";
import { getDatabaseAdapterUpdateInfo } from "./databaseAdapterUpdateInfo";
import { fromStoredBundleRow } from "./databaseAdapterUtils";
import {
  createDrizzleCrud,
  getDrizzleColumn,
  getDrizzleTable,
} from "./drizzleCrud";
import { createLazyDB } from "./drizzleLazyDB";
import { buildDrizzleWhere } from "./drizzleQuery";

export type DrizzleProvider = Exclude<
  ORMProvider,
  "cockroachdb" | "mongodb" | "mssql"
>;

export interface DrizzleConfig {
  readonly db: unknown | (() => unknown | Promise<unknown>);
  readonly provider: DrizzleProvider;
  readonly schema?: Record<string, unknown>;
  readonly transaction?: boolean;
}

const createImplementation = <TContext>(
  config: DrizzleConfig,
): DatabaseAdapterImplementation<HotUpdaterContext<TContext>> => {
  const db = createLazyDB(config);
  const crud = createDrizzleCrud(db, config.provider);
  const bundles = getDrizzleTable(db, "bundles");
  const patches = getDrizzleTable(db, "bundle_patches");
  const channels = getDrizzleTable(db, "channels");
  const transaction = db.transaction?.bind(db);
  return {
    ...crud,
    ...(transaction
      ? {
          delete: (input: Parameters<typeof crud.delete>[0]) =>
            transaction((transactionDatabase) =>
              createDrizzleCrud(transactionDatabase, config.provider).delete(
                input,
              ),
            ),
        }
      : {}),
    getUpdateInfo: (args, context) =>
      getDatabaseAdapterUpdateInfo(
        {
          findChannel: (name) =>
            db.query.channels
              .findFirst({
                where: buildDrizzleWhere<"channels">(
                  config.provider,
                  channels,
                  [{ field: "name", value: name }],
                ),
              })
              .then((row) => row ?? null),
          findBundles: async (where) => {
            const rows = await db.query.bundles.findMany({
              where: buildDrizzleWhere(config.provider, bundles, where),
              orderBy: [desc(getDrizzleColumn(bundles, "id"))],
            });
            return rows.map(fromStoredBundleRow);
          },
          findPatches: (bundleIds) =>
            bundleIds.length === 0
              ? Promise.resolve([])
              : db.query.bundle_patches.findMany({
                  where: inArray(
                    getDrizzleColumn(patches, "bundle_id"),
                    bundleIds,
                  ),
                  orderBy: [asc(getDrizzleColumn(patches, "order_index"))],
                }),
        },
        args,
        context,
      ),
    ...(transaction
      ? {
          transaction: async <TResult>(
            callback: (
              transaction: TransactionDatabaseAdapterImplementation,
            ) => Promise<TResult>,
          ): Promise<TResult> =>
            transaction((transaction) =>
              callback(createDrizzleCrud(transaction, config.provider)),
            ),
        }
      : {}),
  };
};

export const drizzleAdapter = <TContext = unknown>(
  config: DrizzleConfig,
): DatabaseAdapterWithCapabilities<HotUpdaterContext<TContext>> => {
  const adapter = createDatabaseAdapter({
    name: "drizzle",
    supportsBundleEvents: true,
    adapter: (): DatabaseAdapterImplementation<HotUpdaterContext<TContext>> =>
      createImplementation<TContext>(config),
  });
  return Object.assign(adapter, {
    adapterName: "drizzle",
    provider: config.provider,
    generateSchema: (version: Parameters<SchemaGenerator>[0]) => ({
      code: generateDrizzleSchema(
        config.provider,
        version === "latest"
          ? hotUpdaterSchema
          : getHotUpdaterSchemaVersion(version),
      ),
      path: "hot-updater-schema.ts",
    }),
  });
};
