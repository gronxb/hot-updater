// noqa: SIZE_OK - Existing Kysely adapter module; splitting belongs to a dedicated adapter cleanup.
import { NIL_UUID } from "@hot-updater/core";
import type {
  Bundle,
  BundleEventFindManyQuery,
  BundlePatchFindManyQuery,
  DatabaseBundleQueryWhere,
  DatabaseBundleRecord,
  DatabasePluginDeclaration,
} from "@hot-updater/plugin-core";
import {
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";
import {
  buildBundlePatchRowResource,
  createBundleEventResource,
  createBundleResource,
  createDatabasePlugin,
  setBundleEventResourceOverride,
  setBundlePatchResourceOverride,
  setBundleResourceOverride,
  toPatch,
  type BundleEventStore,
  type BundlePatchRowStore,
  type BundleStore,
} from "@hot-updater/plugin-core/internal";
import {
  Kysely,
  sql,
  type Dialect,
  type Expression,
  type ExpressionBuilder,
  type RawBuilder,
  type SqlBool,
  type Transaction,
} from "kysely";

import {
  bundleRecordToRow,
  type BundleEventRow,
  type BundlePatchRow,
  type BundleRow,
  databaseBundleEventToProviderRow,
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

const hasEmptyBundleFilter = (where: DatabaseBundleQueryWhere | undefined) =>
  where?.id?.in?.length === 0 || where?.targetAppVersionIn?.length === 0;

const buildKyselyBundleWhere =
  (where: DatabaseBundleQueryWhere | undefined, provider: KyselySQLProvider) =>
  (eb: ExpressionBuilder<HotUpdaterKyselyDatabase, "bundles">) => {
    const conditions: Expression<SqlBool>[] = [];
    if (where?.channel !== undefined)
      conditions.push(eb("channel", "=", where.channel));
    if (where?.platform !== undefined)
      conditions.push(eb("platform", "=", where.platform));
    if (where?.enabled !== undefined)
      conditions.push(eb("enabled", "=", where.enabled));
    if (where?.fingerprintHash !== undefined) {
      conditions.push(
        where.fingerprintHash === null
          ? eb("fingerprint_hash", "is", null)
          : eb("fingerprint_hash", "=", where.fingerprintHash),
      );
    }
    if (where?.targetAppVersion !== undefined) {
      conditions.push(
        where.targetAppVersion === null
          ? eb("target_app_version", "is", null)
          : eb("target_app_version", "=", where.targetAppVersion),
      );
    }
    if (where?.targetAppVersionIn?.length) {
      conditions.push(
        eb(
          "target_app_version",
          "in",
          stringInValues(where.targetAppVersionIn, provider),
        ),
      );
    }
    if (where?.targetAppVersionNotNull) {
      conditions.push(eb("target_app_version", "is not", null));
    }
    if (where?.id?.eq !== undefined)
      conditions.push(eb("id", "=", where.id.eq));
    if (where?.id?.gt !== undefined)
      conditions.push(eb("id", ">", where.id.gt));
    if (where?.id?.gte !== undefined)
      conditions.push(eb("id", ">=", where.id.gte));
    if (where?.id?.lt !== undefined)
      conditions.push(eb("id", "<", where.id.lt));
    if (where?.id?.lte !== undefined)
      conditions.push(eb("id", "<=", where.id.lte));
    if (where?.id?.in?.length) {
      conditions.push(eb("id", "in", stringInValues(where.id.in, provider)));
    }
    return eb.and(conditions);
  };

const hasEmptyPatchFilter = (where: BundlePatchFindManyQuery["where"]) =>
  where?.idIn?.length === 0 ||
  where?.bundleIdIn?.length === 0 ||
  where?.baseBundleIdIn?.length === 0;

const buildKyselyPatchWhere =
  (where: BundlePatchFindManyQuery["where"], provider: KyselySQLProvider) =>
  (eb: ExpressionBuilder<HotUpdaterKyselyDatabase, "bundle_patches">) => {
    const conditions: Expression<SqlBool>[] = [];
    if (where?.id !== undefined) conditions.push(eb("id", "=", where.id));
    if (where?.bundleId !== undefined)
      conditions.push(eb("bundle_id", "=", where.bundleId));
    if (where?.baseBundleId !== undefined)
      conditions.push(eb("base_bundle_id", "=", where.baseBundleId));
    if (where?.idIn?.length)
      conditions.push(eb("id", "in", stringInValues(where.idIn, provider)));
    if (where?.bundleIdIn?.length) {
      conditions.push(
        eb("bundle_id", "in", stringInValues(where.bundleIdIn, provider)),
      );
    }
    if (where?.baseBundleIdIn?.length) {
      conditions.push(
        eb(
          "base_bundle_id",
          "in",
          stringInValues(where.baseBundleIdIn, provider),
        ),
      );
    }
    return eb.and(conditions);
  };

const buildKyselyEventWhere =
  (where: BundleEventFindManyQuery["where"]) =>
  (eb: ExpressionBuilder<HotUpdaterKyselyDatabase, "bundle_events">) => {
    const conditions: Expression<SqlBool>[] = [];
    if (where?.kind !== undefined) conditions.push(eb("kind", "=", where.kind));
    if (where?.installId !== undefined)
      conditions.push(eb("install_id", "=", where.installId));
    if (where?.activeBundleId !== undefined)
      conditions.push(eb("active_bundle_id", "=", where.activeBundleId));
    if (where?.previousActiveBundleId !== undefined)
      conditions.push(
        eb("previous_active_bundle_id", "=", where.previousActiveBundleId),
      );
    if (where?.crashedBundleId !== undefined)
      conditions.push(eb("crashed_bundle_id", "=", where.crashedBundleId));
    if (where?.platform !== undefined)
      conditions.push(eb("platform", "=", where.platform));
    if (where?.channel !== undefined)
      conditions.push(eb("channel", "=", where.channel));
    if (where?.appVersion !== undefined)
      conditions.push(eb("app_version", "=", where.appVersion));
    if (where?.fingerprintHash !== undefined)
      conditions.push(eb("fingerprint_hash", "=", where.fingerprintHash));
    if (where?.cohort !== undefined)
      conditions.push(eb("cohort", "=", where.cohort));
    if (where?.userId !== undefined)
      conditions.push(eb("user_id", "=", where.userId));
    return eb.and(conditions);
  };

const patchOrderColumns = {
  id: "id",
  bundleId: "bundle_id",
  baseBundleId: "base_bundle_id",
  orderIndex: "order_index",
} as const;

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

      const bundleStore: BundleStore = {
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
      };
      setBundleResourceOverride(bundleStore, {
        ...createBundleResource(bundleStore),
        async findMany({ where, window, orderBy }) {
          if (hasEmptyBundleFilter(where)) return [];
          const rows = await executor
            .selectFrom("bundles")
            .selectAll()
            .where(buildKyselyBundleWhere(where, provider))
            .orderBy("id", orderBy?.direction ?? "desc")
            .limit(window.limit)
            .offset(window.offset)
            .execute();
          return rows.map(rowToDatabaseBundleRecord);
        },
        async count({ where }) {
          if (hasEmptyBundleFilter(where)) return 0;
          const result = await executor
            .selectFrom("bundles")
            .select(sql<number>`count(*)`.as("count"))
            .where(buildKyselyBundleWhere(where, provider))
            .executeTakeFirst();
          return Number(result?.count ?? 0);
        },
      });

      const patchStore: BundlePatchRowStore & { readonly storage: "rows" } = {
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
      };
      setBundlePatchResourceOverride(patchStore, {
        ...buildBundlePatchRowResource(patchStore),
        async findMany({ where, window, orderBy }) {
          if (hasEmptyPatchFilter(where)) return [];
          const direction = orderBy?.direction ?? "asc";
          const orderField = patchOrderColumns[orderBy?.field ?? "orderIndex"];
          const orderedQuery = executor
            .selectFrom("bundle_patches")
            .selectAll()
            .where(buildKyselyPatchWhere(where, provider))
            .orderBy(orderField, direction);
          const rows = await (
            orderField === "id"
              ? orderedQuery
              : orderedQuery.orderBy("id", direction)
          )
            .limit(window.limit)
            .offset(window.offset)
            .execute();
          return rows.map(toPatch);
        },
        async count({ where }) {
          if (hasEmptyPatchFilter(where)) return 0;
          const result = await executor
            .selectFrom("bundle_patches")
            .select(sql<number>`count(*)`.as("count"))
            .where(buildKyselyPatchWhere(where, provider))
            .executeTakeFirst();
          return Number(result?.count ?? 0);
        },
      });

      const eventStore: BundleEventStore = {
        async findEvents() {
          const rows = await executor
            .selectFrom("bundle_events")
            .selectAll()
            .execute();
          return rows.map(rowToDatabaseBundleEvent);
        },
        async append({ event }) {
          const row = databaseBundleEventToProviderRow(event, provider);
          if (provider === "mysql") {
            await executor
              .insertInto("bundle_events")
              .values(row)
              .onDuplicateKeyUpdate({ id: event.id })
              .execute();
          } else {
            await executor
              .insertInto("bundle_events")
              .values(row)
              .onConflict((oc) => oc.column("id").doNothing())
              .execute();
          }
        },
        async deleteBeforeId({ beforeId }) {
          await executor
            .deleteFrom("bundle_events")
            .where("id", "<", beforeId)
            .execute();
        },
      };
      setBundleEventResourceOverride(eventStore, {
        ...createBundleEventResource(eventStore),
        async findMany({ where, window, orderBy }) {
          const rows = await executor
            .selectFrom("bundle_events")
            .selectAll()
            .where(buildKyselyEventWhere(where))
            .orderBy("id", orderBy?.direction ?? "desc")
            .limit(window.limit)
            .offset(window.offset)
            .execute();
          return rows.map(rowToDatabaseBundleEvent);
        },
        async count({ where }) {
          const result = await executor
            .selectFrom("bundle_events")
            .select(sql<number>`count(*)`.as("count"))
            .where(buildKyselyEventWhere(where))
            .executeTakeFirst();
          return Number(result?.count ?? 0);
        },
      });

      return {
        bundles: bundleStore,
        patches: patchStore,
        bundleEvents: eventStore,
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
