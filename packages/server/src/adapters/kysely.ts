// noqa: SIZE_OK - Existing Kysely adapter module; splitting belongs to a dedicated adapter cleanup.
import { NIL_UUID } from "@hot-updater/core";
import type {
  Bundle,
  DatabaseBundleRecord,
  DatabasePluginDeclaration,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core/internal";
import {
  Kysely,
  sql,
  type Dialect,
  type RawBuilder,
  type Transaction,
} from "kysely";

import {
  bundleRecordToRow,
  type BundleEventRow,
  type BundlePatchRow,
  type BundleRow,
  databaseBundleEventToRow,
  rowToDatabaseBundleEvent,
  rowToDatabaseBundleRecord,
  rowToBundle,
} from "../db/bundleRows";
import { createKyselyMigrator } from "../db/fixedMigrator";
import type {
  DatabaseAdapterRuntime,
  ORMSQLProvider,
  RelationMode,
} from "../db/types";
import { createCallbackDatabaseTransaction } from "./transaction";

type KyselySQLProvider = Exclude<ORMSQLProvider, "mssql">;
type KyselyTransactionMode = "enabled" | "disabled";

export type {
  KyselyTransactionMode as TransactionMode,
  RelationMode,
  KyselySQLProvider as SQLProvider,
};

export interface HotUpdaterKyselyDatabase {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly bundle_events: BundleEventRow;
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

export interface KyselyAdapterConfig {
  readonly adapterName?: string;
  readonly db: Kysely<HotUpdaterKyselyDatabase>;
  readonly destroyOnClose?: boolean;
  readonly provider: KyselySQLProvider;
  readonly relationMode?: RelationMode;
  readonly transactionMode?: KyselyTransactionMode;
}

export interface KyselyDialectDatabaseConfig {
  readonly adapterName?: string;
  readonly dialect: Dialect;
  readonly provider: KyselySQLProvider;
  readonly relationMode?: RelationMode;
  readonly transactionMode?: KyselyTransactionMode;
}

export type KyselyDatabaseConfig =
  | KyselyAdapterConfig
  | KyselyDialectDatabaseConfig;

type ResolvedKyselyDatabase = {
  readonly close?: () => Promise<void>;
  readonly db: Kysely<HotUpdaterKyselyDatabase>;
};

type ResolvedKyselyDatabaseConfig = ResolvedKyselyDatabase & {
  readonly provider: KyselySQLProvider;
  readonly relationMode?: RelationMode;
  readonly transactionMode?: KyselyTransactionMode;
};

const assertKyselySQLProvider: (
  provider: ORMSQLProvider,
) => asserts provider is KyselySQLProvider = (provider) => {
  if (provider === "mssql") {
    throw new Error("Kysely adapter does not support provider: mssql.");
  }
};

const toProviderBundleRow = (
  row: BundleRow,
  provider: KyselySQLProvider,
): BundleRow => {
  if (provider !== "mysql" && provider !== "sqlite") return row;
  const jsonRow = {
    ...row,
    metadata: JSON.stringify(row.metadata ?? {}),
    target_cohorts:
      row.target_cohorts === null || row.target_cohorts === undefined
        ? null
        : JSON.stringify(row.target_cohorts),
  };
  if (provider !== "sqlite") return jsonRow;

  return {
    ...jsonRow,
    enabled: row.enabled ? 1 : 0,
    should_force_update: row.should_force_update ? 1 : 0,
  };
};

const sqliteJsonEachValues = (values: readonly string[]): RawBuilder<string> =>
  sql<string>`(select value from json_each(${JSON.stringify(values)}))`;

const stringInValues = (
  values: readonly string[],
  provider: KyselySQLProvider,
): readonly string[] | RawBuilder<string> =>
  provider === "sqlite" ? sqliteJsonEachValues(values) : [...values];

const createDestroyOnce = (
  db: Kysely<HotUpdaterKyselyDatabase>,
): (() => Promise<void>) => {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= db.destroy();
    return closePromise;
  };
};

const resolveKyselyDatabase = (
  config: KyselyDatabaseConfig,
): ResolvedKyselyDatabase => {
  if ("dialect" in config) {
    const db = new Kysely<HotUpdaterKyselyDatabase>({
      dialect: config.dialect,
    });
    return { close: createDestroyOnce(db), db };
  }

  return {
    ...(config.destroyOnClose ? { close: createDestroyOnce(config.db) } : {}),
    db: config.db,
  };
};

const createKyselyPlugin = createDatabasePlugin({
  name: "kysely",
  connect: (
    config: ResolvedKyselyDatabaseConfig,
  ): DatabasePluginDeclaration => {
    const { close, db } = config;
    const { provider } = config;
    const upsertBundleRecord = async (
      executor:
        | Kysely<HotUpdaterKyselyDatabase>
        | Transaction<HotUpdaterKyselyDatabase>,
      bundle: DatabaseBundleRecord,
    ) => {
      const row = toProviderBundleRow(bundleRecordToRow(bundle), provider);
      const { id: _id, ...updateRow } = row;
      if (provider === "mysql") {
        await executor
          .insertInto("bundles")
          .values(row)
          .onDuplicateKeyUpdate(updateRow)
          .execute();
      } else {
        await executor
          .insertInto("bundles")
          .values(row)
          .onConflict((oc) => oc.column("id").doUpdateSet(updateRow))
          .execute();
      }
    };

    const createConnection = (
      executor:
        | Kysely<HotUpdaterKyselyDatabase>
        | Transaction<HotUpdaterKyselyDatabase>,
    ): DatabasePluginDeclaration => {
      const fetchPatchMap = async (bundleIds: readonly string[]) => {
        const patchMap = new Map<string, BundlePatchRow[]>();
        if (bundleIds.length === 0) return patchMap;
        const rows = await executor
          .selectFrom("bundle_patches")
          .selectAll()
          .where("bundle_id", "in", stringInValues(bundleIds, provider))
          .orderBy("order_index", "asc")
          .execute();
        for (const row of rows) {
          const current = patchMap.get(row.bundle_id) ?? [];
          current.push(row);
          patchMap.set(row.bundle_id, current);
        }
        return patchMap;
      };
      const mapRowsToBundles = async (
        rows: readonly BundleRow[],
      ): Promise<Bundle[]> => {
        const patchMap = await fetchPatchMap(rows.map((row) => row.id));
        return rows.map((row) => rowToBundle(row, patchMap.get(row.id) ?? []));
      };

      return {
        bundles: {
          async getById({ bundleId }) {
            const row = await executor
              .selectFrom("bundles")
              .selectAll()
              .where("id", "=", bundleId)
              .executeTakeFirst();
            return row ? rowToDatabaseBundleRecord(row) : null;
          },
          async findRecords() {
            const rows = await executor
              .selectFrom("bundles")
              .selectAll()
              .execute();
            return rows.map(rowToDatabaseBundleRecord);
          },
          async insert({ bundle }) {
            await upsertBundleRecord(executor, bundle);
          },
          async update({ bundleId, patch }) {
            const row = await executor
              .selectFrom("bundles")
              .selectAll()
              .where("id", "=", bundleId)
              .executeTakeFirst();
            if (!row) throw new Error("targetBundleId not found");
            await upsertBundleRecord(executor, {
              ...rowToDatabaseBundleRecord(row),
              ...patch,
              id: bundleId,
            });
          },
          async delete({ bundleId }) {
            await executor
              .deleteFrom("bundles")
              .where("id", "=", bundleId)
              .execute();
          },
        },
        patches: {
          storage: "rows",
          async findRows() {
            return await executor
              .selectFrom("bundle_patches")
              .selectAll()
              .orderBy("order_index", "asc")
              .execute();
          },
          async getRowById({ patchId }) {
            return (
              (await executor
                .selectFrom("bundle_patches")
                .selectAll()
                .where("id", "=", patchId)
                .executeTakeFirst()) ?? null
            );
          },
          async insertRow({ row }) {
            const { id: _id, ...updateRow } = row;
            if (provider === "mysql") {
              await executor
                .insertInto("bundle_patches")
                .values(row)
                .onDuplicateKeyUpdate(updateRow)
                .execute();
            } else {
              await executor
                .insertInto("bundle_patches")
                .values(row)
                .onConflict((oc) => oc.column("id").doUpdateSet(updateRow))
                .execute();
            }
          },
          async updateRow({ patchId, row }) {
            await executor
              .updateTable("bundle_patches")
              .set(row)
              .where("id", "=", patchId)
              .execute();
          },
          async deleteRow({ patchId }) {
            await executor
              .deleteFrom("bundle_patches")
              .where("id", "=", patchId)
              .execute();
          },
        },
        bundleEvents: {
          async findEvents() {
            const rows = await executor
              .selectFrom("bundle_events")
              .selectAll()
              .execute();
            return rows.map(rowToDatabaseBundleEvent);
          },
          async append({ event }) {
            await executor
              .insertInto("bundle_events")
              .values(databaseBundleEventToRow(event))
              .execute();
          },
        },
        updateInfo: {
          async get(args) {
            if (args._updateStrategy === "appVersion") {
              const channel = args.channel ?? "production";
              const minBundleId = args.minBundleId ?? NIL_UUID;
              const rows = await executor
                .selectFrom("bundles")
                .select("target_app_version")
                .where("enabled", "=", true)
                .where("platform", "=", args.platform)
                .where("channel", "=", channel)
                .where("id", ">=", minBundleId)
                .where("target_app_version", "is not", null)
                .execute();

              const targetAppVersions = Array.from(
                new Set(
                  rows
                    .map((row) => row.target_app_version)
                    .filter(
                      (value): value is string =>
                        typeof value === "string" && value.length > 0,
                    ),
                ),
              );
              const compatibleAppVersions = filterCompatibleAppVersions(
                targetAppVersions,
                args.appVersion,
              );
              const bundles =
                compatibleAppVersions.length > 0
                  ? await executor
                      .selectFrom("bundles")
                      .selectAll()
                      .where("enabled", "=", true)
                      .where("platform", "=", args.platform)
                      .where("channel", "=", channel)
                      .where("id", ">=", minBundleId)
                      .where(
                        "target_app_version",
                        "in",
                        stringInValues(compatibleAppVersions, provider),
                      )
                      .orderBy("id", "desc")
                      .execute()
                      .then(mapRowsToBundles)
                  : [];

              return resolveUpdateInfoFromBundles({
                args: { ...args, channel, minBundleId },
                bundles,
              });
            }

            const channel = args.channel ?? "production";
            const minBundleId = args.minBundleId ?? NIL_UUID;
            const rows = await executor
              .selectFrom("bundles")
              .selectAll()
              .where("enabled", "=", true)
              .where("platform", "=", args.platform)
              .where("channel", "=", channel)
              .where("id", ">=", minBundleId)
              .where("fingerprint_hash", "=", args.fingerprintHash)
              .orderBy("id", "desc")
              .execute();

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles: await mapRowsToBundles(rows),
            });
          },
        },
      };
    };

    return {
      ...createConnection(db),
      ...(close ? { close } : {}),
      ...(config.transactionMode === "disabled"
        ? {}
        : {
            beginTransaction: () =>
              createCallbackDatabaseTransaction<
                Transaction<HotUpdaterKyselyDatabase>
              >({
                createConnection,
                run: (operation) => db.transaction().execute(operation),
              }),
          }),
    };
  },
});

export const createKyselyDatabase = (
  config: KyselyDatabaseConfig,
): DatabaseAdapterRuntime => {
  assertKyselySQLProvider(config.provider);
  const { close, db } = resolveKyselyDatabase(config);
  const pluginConfig: ResolvedKyselyDatabaseConfig = {
    ...(close ? { close } : {}),
    ...(config.relationMode ? { relationMode: config.relationMode } : {}),
    ...(config.transactionMode
      ? { transactionMode: config.transactionMode }
      : {}),
    db,
    provider: config.provider,
  };
  return Object.assign(createKyselyPlugin(pluginConfig), {
    adapterName: config.adapterName ?? "kysely",
    provider: config.provider,
    createMigrator: () =>
      createKyselyMigrator({
        db,
        provider: config.provider,
        relationMode: config.relationMode,
      }),
  });
};

export const kyselyDatabase = createKyselyDatabase;
export const kyselyAdapter = kyselyDatabase;
