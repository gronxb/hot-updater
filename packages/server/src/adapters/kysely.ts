import { NIL_UUID } from "@hot-updater/core";
import type {
  Bundle,
  BundlePatchListQuery,
  DatabaseBundlePatch,
  DatabaseBundleQueryWhere,
  DatabaseBundleRecord,
  DatabasePluginCore,
  DatabasePluginRuntime,
} from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  filterCompatibleAppVersions,
  resolveUpdateInfoFromBundles,
} from "@hot-updater/plugin-core";
import type { Kysely, Transaction } from "kysely";

import {
  bundleEventMatchesWhere,
  bundleRecordToRow,
  type BundleEventRow,
  type BundlePatchRow,
  type BundleRow,
  databaseBundleEventToRow,
  databaseBundlePatchToRow,
  databaseBundlePatchUpdateToRow,
  paginateCursorItems,
  rowToDatabaseBundleEvent,
  rowToDatabaseBundlePatch,
  rowToDatabaseBundleRecord,
  rowToBundle,
} from "../db/bundleRows";
import { createKyselyMigrator } from "../db/fixedMigrator";
import type {
  DatabaseAdapterCapabilities,
  ORMSQLProvider,
  RelationMode,
} from "../db/types";
import { createCallbackDatabaseTransaction } from "./transaction";

const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`;

const getPatchStringField = (
  patch: DatabaseBundlePatch,
  field: Exclude<
    NonNullable<BundlePatchListQuery["orderBy"]>["field"],
    "orderIndex"
  >,
): string => (field === "id" ? getPatchId(patch) : patch[field]);

const patchMatchesWhere = (
  patch: DatabaseBundlePatch,
  where: BundlePatchListQuery["where"],
) =>
  !where ||
  ((where.id === undefined || getPatchId(patch) === where.id) &&
    (where.bundleId === undefined || patch.bundleId === where.bundleId) &&
    (where.baseBundleId === undefined ||
      patch.baseBundleId === where.baseBundleId) &&
    (where.idIn === undefined || where.idIn.includes(getPatchId(patch))) &&
    (where.bundleIdIn === undefined ||
      where.bundleIdIn.includes(patch.bundleId)) &&
    (where.baseBundleIdIn === undefined ||
      where.baseBundleIdIn.includes(patch.baseBundleId)));

type KyselySQLProvider = Exclude<ORMSQLProvider, "mssql">;

export type { RelationMode, KyselySQLProvider as SQLProvider };

interface Database {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly bundle_events: BundleEventRow;
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

export interface KyselyAdapterConfig<TDatabase extends object = Database> {
  readonly db: Kysely<TDatabase>;
  readonly provider: KyselySQLProvider;
  readonly relationMode?: RelationMode;
}

const assertKyselySQLProvider: (
  provider: ORMSQLProvider,
) => asserts provider is KyselySQLProvider = (provider) => {
  if (provider === "mssql") {
    throw new Error("Kysely adapter does not support provider: mssql.");
  }
};

const applyWhere = <T extends object>(
  query: T,
  where: DatabaseBundleQueryWhere | undefined,
): T => {
  let next = query as {
    where: (column: string, op: string, value?: unknown) => unknown;
  };
  if (where?.channel !== undefined)
    next = next.where("channel", "=", where.channel) as typeof next;
  if (where?.platform !== undefined)
    next = next.where("platform", "=", where.platform) as typeof next;
  if (where?.enabled !== undefined)
    next = next.where("enabled", "=", where.enabled) as typeof next;
  if (where?.fingerprintHash !== undefined) {
    next =
      where.fingerprintHash === null
        ? (next.where("fingerprint_hash", "is", null) as typeof next)
        : (next.where(
            "fingerprint_hash",
            "=",
            where.fingerprintHash,
          ) as typeof next);
  }
  if (where?.targetAppVersion !== undefined) {
    next =
      where.targetAppVersion === null
        ? (next.where("target_app_version", "is", null) as typeof next)
        : (next.where(
            "target_app_version",
            "=",
            where.targetAppVersion,
          ) as typeof next);
  }
  if (where?.targetAppVersionIn) {
    next = next.where(
      "target_app_version",
      "in",
      where.targetAppVersionIn,
    ) as typeof next;
  }
  if (where?.targetAppVersionNotNull) {
    next = next.where("target_app_version", "is not", null) as typeof next;
  }
  if (where?.id?.eq) next = next.where("id", "=", where.id.eq) as typeof next;
  if (where?.id?.gt) next = next.where("id", ">", where.id.gt) as typeof next;
  if (where?.id?.gte)
    next = next.where("id", ">=", where.id.gte) as typeof next;
  if (where?.id?.lt) next = next.where("id", "<", where.id.lt) as typeof next;
  if (where?.id?.lte)
    next = next.where("id", "<=", where.id.lte) as typeof next;
  if (where?.id?.in) next = next.where("id", "in", where.id.in) as typeof next;
  return next as T;
};

const hasEmptySetFilter = (
  where: DatabaseBundleQueryWhere | undefined,
): boolean =>
  where?.targetAppVersionIn?.length === 0 || where?.id?.in?.length === 0;

const toProviderBundleRow = (
  row: BundleRow,
  provider: KyselySQLProvider,
): BundleRow => {
  if (provider !== "mysql" && provider !== "sqlite") return row;
  return {
    ...row,
    metadata: JSON.stringify(row.metadata ?? {}),
    target_cohorts:
      row.target_cohorts === null || row.target_cohorts === undefined
        ? null
        : JSON.stringify(row.target_cohorts),
  };
};

const createKyselyPlugin = createDatabasePlugin({
  name: "kysely",
  connect: ({
    db,
    provider,
  }: KyselyAdapterConfig<Database>): DatabasePluginCore => {
    const upsertBundleRecord = async (
      executor: Kysely<Database> | Transaction<Database>,
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

    const createCore = (
      executor: Kysely<Database> | Transaction<Database>,
    ): DatabasePluginCore => {
      const fetchPatchMap = async (bundleIds: readonly string[]) => {
        const patchMap = new Map<string, BundlePatchRow[]>();
        if (bundleIds.length === 0) return patchMap;
        const rows = await executor
          .selectFrom("bundle_patches")
          .selectAll()
          .where("bundle_id", "in", [...bundleIds])
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
          async findMany({ where, orderBy, window }) {
            if (hasEmptySetFilter(where)) {
              return [];
            }
            const bundleOrder = orderBy ?? {
              field: "id",
              direction: "desc",
            };
            const rows = await applyWhere(
              executor.selectFrom("bundles").selectAll(),
              where,
            )
              .orderBy("id", bundleOrder.direction)
              .execute();
            return rows
              .slice(window.offset, window.offset + window.limit)
              .map(rowToDatabaseBundleRecord);
          },
          async count({ where }) {
            if (hasEmptySetFilter(where)) {
              return 0;
            }
            const rows = await applyWhere(
              executor.selectFrom("bundles").select(["id"]),
              where,
            ).execute();
            return rows.length;
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
        bundlePatches: {
          async findMany({ where, orderBy, window }) {
            const rows = await executor
              .selectFrom("bundle_patches")
              .selectAll()
              .orderBy("order_index", "asc")
              .execute();
            const patches = rows
              .map(rowToDatabaseBundlePatch)
              .filter((patch) => patchMatchesWhere(patch, where))
              .sort((left, right) => {
                const direction = orderBy?.direction ?? "asc";
                const field = orderBy?.field ?? "orderIndex";
                const result =
                  field === "orderIndex"
                    ? left.orderIndex - right.orderIndex ||
                      getPatchId(left).localeCompare(getPatchId(right))
                    : getPatchStringField(left, field).localeCompare(
                        getPatchStringField(right, field),
                      );
                return direction === "asc" ? result : -result;
              });
            return patches.slice(window.offset, window.offset + window.limit);
          },
          async count({ where }) {
            const rows = await executor
              .selectFrom("bundle_patches")
              .selectAll()
              .execute();
            return rows
              .map(rowToDatabaseBundlePatch)
              .filter((patch) => patchMatchesWhere(patch, where)).length;
          },
          async getById({ patchId }) {
            const row = await executor
              .selectFrom("bundle_patches")
              .selectAll()
              .where("id", "=", patchId)
              .executeTakeFirst();
            return row ? rowToDatabaseBundlePatch(row) : null;
          },
          async insert({ patch }) {
            const row = databaseBundlePatchToRow(patch);
            const { id: _id, ...updateRow } = row;
            await executor
              .insertInto("bundle_patches")
              .values(row)
              .onConflict((oc) => oc.column("id").doUpdateSet(updateRow))
              .execute();
          },
          async update({ patchId, patch }) {
            await executor
              .updateTable("bundle_patches")
              .set(databaseBundlePatchUpdateToRow(patch))
              .where("id", "=", patchId)
              .execute();
          },
          async delete({ patchId }) {
            await executor
              .deleteFrom("bundle_patches")
              .where("id", "=", patchId)
              .execute();
          },
        },
        bundleEvents: {
          async list(options) {
            const rows = await executor
              .selectFrom("bundle_events")
              .selectAll()
              .orderBy("id", options.orderBy?.direction ?? "desc")
              .execute();
            const events = rows
              .map(rowToDatabaseBundleEvent)
              .filter((event) => bundleEventMatchesWhere(event, options.where));
            return paginateCursorItems({
              items: events,
              limit: options.limit,
              cursor: options.cursor,
              getCursor: (event) => event.id,
            });
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
                      .where("target_app_version", "in", compatibleAppVersions)
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
      ...createCore(db),
      beginTransaction: () =>
        createCallbackDatabaseTransaction<Transaction<Database>>({
          createCore,
          run: (operation) => db.transaction().execute(operation),
        }),
    };
  },
});

export const kyselyAdapter = <TDatabase extends object>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabaseAdapterCapabilities & DatabasePluginRuntime => {
  assertKyselySQLProvider(config.provider);
  return Object.assign(
    createKyselyPlugin(config as unknown as KyselyAdapterConfig<Database>),
    {
      adapterName: "kysely",
      provider: config.provider,
      createMigrator: () =>
        createKyselyMigrator({
          db: config.db as unknown as Kysely<{
            private_hot_updater_settings: {
              key: string;
              value: string;
            };
          }>,
          provider: config.provider,
          relationMode: config.relationMode,
        }),
    },
  );
};
