import {
  createDatabasePlugin,
  type DatabasePluginImplementation,
  type TransactionDatabasePluginImplementation,
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
import { getDatabasePluginUpdateInfo } from "./databasePluginUpdateInfo";
import { fromStoredBundleRow } from "./databasePluginUtils";
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

const createImplementation = (
  config: DrizzleConfig,
): DatabasePluginImplementation => {
  const db = createLazyDB(config);
  const crud = createDrizzleCrud(db, config.provider);
  const bundles = getDrizzleTable(db, "bundles");
  const patches = getDrizzleTable(db, "bundle_patches");
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
    getUpdateInfo: (args) =>
      getDatabasePluginUpdateInfo(
        {
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
      ),
    getChannels: async () => {
      const rows = await db.query.bundles.findMany();
      return [...new Set(rows.map(({ channel }) => channel))].sort();
    },
    ...(transaction
      ? {
          transaction: async <TResult>(
            callback: (
              transaction: TransactionDatabasePluginImplementation,
            ) => Promise<TResult>,
          ): Promise<TResult> =>
            transaction((transaction) =>
              callback(createDrizzleCrud(transaction, config.provider)),
            ),
        }
      : {}),
  };
};

export const drizzleAdapter = (
  config: DrizzleConfig,
): DatabaseAdapterWithCapabilities => {
  const plugin = createDatabasePlugin({
    name: "drizzle",
    plugin: (): DatabasePluginImplementation => createImplementation(config),
  });
  return Object.assign(plugin, {
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
