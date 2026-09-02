import {
  createDatabasePlugin,
  type InsightsInstallationPageInput,
  type InsightsModel,
} from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  type DatabasePluginImplementation,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";

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
import { createDrizzleCrud } from "./drizzleCrud";
import { createLazyDB } from "./drizzleLazyDB";
import { createDrizzleInsightsQueries } from "./sqlInsights/drizzle";

export type DrizzleProvider = Exclude<
  ORMProvider,
  "cockroachdb" | "mongodb" | "mssql"
>;

export interface DrizzleConfig {
  readonly db: unknown | (() => unknown | Promise<unknown>);
  readonly provider: DrizzleProvider;
  readonly insightsDatabaseNamespace: string;
  readonly schema?: Record<string, unknown>;
  readonly transaction?: boolean;
}

const createImplementation = (
  config: DrizzleConfig,
): DatabasePluginImplementation => {
  const db = createLazyDB(config);
  const crud = createDrizzleCrud(db, config.provider);
  const insights = createDrizzleInsightsQueries(
    db,
    config.provider,
    config.insightsDatabaseNamespace,
  );
  const transaction = db.transaction?.bind(db);
  return {
    ...crud,
    insights,
    deleteChannel: (input) => {
      if (transaction === undefined) {
        throw new Error(
          "Drizzle channel deletion requires transaction support.",
        );
      }
      return transaction((transactionDatabase) =>
        createDrizzleCrud(transactionDatabase, config.provider).deleteChannel(
          input,
        ),
      );
    },
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
  let adapter: ReturnType<typeof createDatabasePluginAdapter> | undefined;
  const getAdapter = () => {
    adapter ??= createDatabasePluginAdapter(
      "drizzle",
      createImplementation(config),
    );
    return adapter;
  };
  const plugin = createDatabasePlugin({
    name: "drizzle",
    models: {
      bundles: {
        findById: (id) => getAdapter().models.bundles.findById(id),
        findMany: (query) => getAdapter().models.bundles.findMany(query),
        count: (where) => getAdapter().models.bundles.count(where),
      },
      bundlePatches: {
        findByBundleIds: (bundleIds) =>
          getAdapter().models.bundlePatches.findByBundleIds(bundleIds),
      },
      releases: {
        findById: (id) => getAdapter().models.releases.findById(id),
        findMany: (input) => getAdapter().models.releases.findMany(input),
        findManyByScope: (input) =>
          getAdapter().models.releases.findManyByScope(input),
      },
      releaseCatalogs: {
        findByScopeKey: (scopeKey) =>
          getAdapter().models.releaseCatalogs.findByScopeKey(scopeKey),
        findMany: (input) =>
          getAdapter().models.releaseCatalogs.findMany(input),
      },
      channels: {
        insert: (input) => getAdapter().models.channels.insert(input),
        list: (input) => getAdapter().models.channels.list(input),
        delete: (input) => getAdapter().models.channels.delete(input),
      },
      insights: {
        append: (row) => getAdapter().models.insights.append(row),
        pageEvents: (input) => getAdapter().models.insights.pageEvents(input),
        pageInstallations: ((input: InsightsInstallationPageInput) =>
          getAdapter().models.insights.pageInstallations(
            input,
          )) as InsightsModel["pageInstallations"],
        getReport: (input) => getAdapter().models.insights.getReport(input),
        pageReport: (input) => getAdapter().models.insights.pageReport(input),
      },
      apiKeys: {
        create: (row) => getAdapter().models.apiKeys.create(row),
        findByHash: (hash) => getAdapter().models.apiKeys.findByHash(hash),
        list: () => getAdapter().models.apiKeys.list(),
        revoke: (input) => getAdapter().models.apiKeys.revoke(input),
      },
    },
    commit: (input) => getAdapter().commit(input),
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
