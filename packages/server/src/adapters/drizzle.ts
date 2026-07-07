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
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
} from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

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
import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
} from "../db/schema/registry";
import { generateDrizzleSchema } from "../db/schemaGenerators";
import type {
  DatabaseAdapterCapabilities,
  ORMProvider,
  ORMSQLProvider,
  SchemaGenerator,
} from "../db/types";
import {
  createLazyDB,
  type DrizzleDB,
  type DrizzleTable,
} from "./drizzleLazyDB";
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

export interface DrizzleConfig {
  readonly db: unknown | (() => unknown | Promise<unknown>);
  readonly provider: Exclude<ORMProvider, "cockroachdb" | "mongodb" | "mssql">;
  readonly schema?: Record<string, unknown>;
}

const getTable = (db: DrizzleDB, name: string) => {
  const table = db._.fullSchema[name];
  if (!table) throw new Error(`Drizzle schema is missing table "${name}".`);
  return table;
};

const column = (table: DrizzleTable, name: string): SQLWrapper =>
  table[name] as SQLWrapper;

const buildWhere = (
  table: DrizzleTable,
  where: DatabaseBundleQueryWhere | undefined,
) => {
  const conditions = [];
  if (where?.channel !== undefined)
    conditions.push(eq(column(table, "channel"), where.channel));
  if (where?.platform !== undefined)
    conditions.push(eq(column(table, "platform"), where.platform));
  if (where?.enabled !== undefined)
    conditions.push(eq(column(table, "enabled"), where.enabled));
  if (where?.fingerprintHash !== undefined) {
    conditions.push(
      where.fingerprintHash === null
        ? isNull(column(table, "fingerprint_hash"))
        : eq(column(table, "fingerprint_hash"), where.fingerprintHash),
    );
  }
  if (where?.targetAppVersion !== undefined) {
    conditions.push(
      where.targetAppVersion === null
        ? isNull(column(table, "target_app_version"))
        : eq(column(table, "target_app_version"), where.targetAppVersion),
    );
  }
  if (where?.targetAppVersionIn) {
    conditions.push(
      inArray(column(table, "target_app_version"), where.targetAppVersionIn),
    );
  }
  if (where?.targetAppVersionNotNull) {
    conditions.push(isNotNull(column(table, "target_app_version")));
  }
  if (where?.id?.eq) conditions.push(eq(column(table, "id"), where.id.eq));
  if (where?.id?.gt) conditions.push(gt(column(table, "id"), where.id.gt));
  if (where?.id?.gte) conditions.push(gte(column(table, "id"), where.id.gte));
  if (where?.id?.lt) conditions.push(lt(column(table, "id"), where.id.lt));
  if (where?.id?.lte) conditions.push(lte(column(table, "id"), where.id.lte));
  if (where?.id?.in) conditions.push(inArray(column(table, "id"), where.id.in));
  return conditions.length > 0 ? and(...conditions) : undefined;
};

const createDrizzlePlugin = createDatabasePlugin({
  name: "drizzle",
  connect: (config: DrizzleConfig): DatabasePluginCore => {
    const db = createLazyDB(config);

    const createCore = (activeDB: DrizzleDB): DatabasePluginCore => {
      const bundleTable = () => getTable(activeDB, "bundles");
      const patchTable = () => getTable(activeDB, "bundle_patches");
      const eventTable = () => getTable(activeDB, "bundle_events");
      const upsertBundleRecord = async (bundle: DatabaseBundleRecord) => {
        const row = bundleRecordToRow(bundle);
        const current = await activeDB.query["bundles"]?.findFirst({
          where: eq(column(bundleTable(), "id"), bundle.id),
        });
        if (current) {
          await activeDB
            .update(bundleTable())
            .set(row)
            .where(eq(column(bundleTable(), "id"), bundle.id));
        } else {
          const inserted = activeDB.insert(bundleTable()).values(row);
          if (inserted.execute) await inserted.execute();
          else await inserted;
        }
      };
      const fetchPatchMap = async (bundleIds: readonly string[]) => {
        const patchMap = new Map<string, BundlePatchRow[]>();
        if (bundleIds.length === 0) return patchMap;
        const rows = await activeDB.query["bundle_patches"]?.findMany({
          where: inArray(column(patchTable(), "bundle_id"), [...bundleIds]),
          orderBy: [asc(column(patchTable(), "order_index"))],
        });
        for (const row of rows ?? []) {
          const patch = row as BundlePatchRow;
          const current = patchMap.get(patch.bundle_id) ?? [];
          current.push(patch);
          patchMap.set(patch.bundle_id, current);
        }
        return patchMap;
      };
      const mapRowsToBundles = async (
        rows: readonly Record<string, unknown>[],
      ): Promise<Bundle[]> => {
        const patchMap = await fetchPatchMap(
          rows.map((row) => String(row["id"])),
        );
        return rows.map((row) =>
          rowToBundle(row as BundleRow, patchMap.get(String(row["id"])) ?? []),
        );
      };

      return {
        bundles: {
          async getById({ bundleId }) {
            const row = await activeDB.query["bundles"]?.findFirst({
              where: eq(column(bundleTable(), "id"), bundleId),
            });
            return row ? rowToDatabaseBundleRecord(row as BundleRow) : null;
          },
          async findMany({ where, orderBy, window }) {
            const bundleOrder = orderBy ?? {
              field: "id",
              direction: "desc",
            };
            const queryWhere = buildWhere(bundleTable(), where);
            const rows = await activeDB.query["bundles"]?.findMany({
              where: queryWhere,
              orderBy: [
                bundleOrder.direction === "asc"
                  ? asc(column(bundleTable(), "id"))
                  : desc(column(bundleTable(), "id")),
              ],
              offset: window.offset,
              limit: window.limit,
            });
            return ((rows ?? []) as BundleRow[]).map(rowToDatabaseBundleRecord);
          },
          async count({ where }) {
            const queryWhere = buildWhere(bundleTable(), where);
            return activeDB.$count(bundleTable(), queryWhere);
          },
          async insert({ bundle }) {
            await upsertBundleRecord(bundle);
          },
          async update({ bundleId, patch }) {
            const row = await activeDB.query["bundles"]?.findFirst({
              where: eq(column(bundleTable(), "id"), bundleId),
            });
            if (!row) throw new Error("targetBundleId not found");
            await upsertBundleRecord({
              ...rowToDatabaseBundleRecord(row as BundleRow),
              ...patch,
              id: bundleId,
            });
          },
          async delete({ bundleId }) {
            await activeDB
              .delete(bundleTable())
              .where(eq(column(bundleTable(), "id"), bundleId));
          },
        },
        bundlePatches: {
          async findMany({ where, orderBy, window }) {
            const rows = await activeDB.query["bundle_patches"]?.findMany({
              orderBy: [asc(column(patchTable(), "order_index"))],
            });
            const patchRows = ((rows ?? []) as BundlePatchRow[])
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
            return patchRows.slice(window.offset, window.offset + window.limit);
          },
          async count({ where }) {
            const rows = await activeDB.query["bundle_patches"]?.findMany({
              orderBy: [asc(column(patchTable(), "order_index"))],
            });
            return ((rows ?? []) as BundlePatchRow[])
              .map(rowToDatabaseBundlePatch)
              .filter((patch) => patchMatchesWhere(patch, where)).length;
          },
          async getById({ patchId }) {
            const row = await activeDB.query["bundle_patches"]?.findFirst({
              where: eq(column(patchTable(), "id"), patchId),
            });
            return row ? rowToDatabaseBundlePatch(row as BundlePatchRow) : null;
          },
          async insert({ patch }) {
            const inserted = activeDB
              .insert(patchTable())
              .values(databaseBundlePatchToRow(patch));
            if (inserted.execute) await inserted.execute();
            else await inserted;
          },
          async update({ patchId, patch }) {
            await activeDB
              .update(patchTable())
              .set(databaseBundlePatchUpdateToRow(patch))
              .where(eq(column(patchTable(), "id"), patchId));
          },
          async delete({ patchId }) {
            await activeDB
              .delete(patchTable())
              .where(eq(column(patchTable(), "id"), patchId));
          },
        },
        bundleEvents: {
          async list(options) {
            const rows = await activeDB.query["bundle_events"]?.findMany({
              orderBy: [
                options.orderBy?.direction === "asc"
                  ? asc(column(eventTable(), "id"))
                  : desc(column(eventTable(), "id")),
              ],
            });
            const events = ((rows ?? []) as BundleEventRow[])
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
            const inserted = activeDB
              .insert(eventTable())
              .values(databaseBundleEventToRow(event));
            if (inserted.execute) await inserted.execute();
            else await inserted;
          },
        },
        updateInfo: {
          async get(args) {
            if (args._updateStrategy === "appVersion") {
              const channel = args.channel ?? "production";
              const minBundleId = args.minBundleId ?? NIL_UUID;
              const rows = await activeDB.query["bundles"]?.findMany({
                columns: { target_app_version: true },
                where: buildWhere(bundleTable(), {
                  enabled: true,
                  platform: args.platform,
                  channel,
                  id: { gte: minBundleId },
                  targetAppVersionNotNull: true,
                }),
              });

              const targetAppVersions = Array.from(
                new Set(
                  (rows ?? [])
                    .map((row) => row["target_app_version"])
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
              const updateRows =
                compatibleAppVersions.length > 0
                  ? await activeDB.query["bundles"]?.findMany({
                      where: buildWhere(bundleTable(), {
                        enabled: true,
                        platform: args.platform,
                        channel,
                        id: { gte: minBundleId },
                        targetAppVersionIn: compatibleAppVersions,
                      }),
                      orderBy: [desc(column(bundleTable(), "id"))],
                    })
                  : [];

              return resolveUpdateInfoFromBundles({
                args: { ...args, channel, minBundleId },
                bundles: await mapRowsToBundles(updateRows ?? []),
              });
            }

            const channel = args.channel ?? "production";
            const minBundleId = args.minBundleId ?? NIL_UUID;
            const rows = await activeDB.query["bundles"]?.findMany({
              where: buildWhere(bundleTable(), {
                enabled: true,
                platform: args.platform,
                channel,
                id: { gte: minBundleId },
                fingerprintHash: args.fingerprintHash,
              }),
              orderBy: [desc(column(bundleTable(), "id"))],
            });

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles: await mapRowsToBundles(rows ?? []),
            });
          },
        },
      };
    };

    const core = createCore(db);
    const runTransaction = db.transaction;
    if (typeof runTransaction !== "function") {
      return core;
    }

    return {
      ...core,
      beginTransaction: () =>
        createCallbackDatabaseTransaction<DrizzleDB>({
          createCore,
          run: (operation) => runTransaction.call(db, operation),
        }),
    };
  },
});

export const drizzleAdapter = (
  config: DrizzleConfig,
): DatabaseAdapterCapabilities & DatabasePluginRuntime => {
  return Object.assign(createDrizzlePlugin(config), {
    adapterName: "drizzle",
    provider: config.provider,
    generateSchema: (version: Parameters<SchemaGenerator>[0]) => ({
      code: generateDrizzleSchema(
        config.provider as ORMSQLProvider,
        version === "latest"
          ? hotUpdaterSchema
          : getHotUpdaterSchemaVersion(version),
      ),
      path: "hot-updater-schema.ts",
    }),
  });
};
