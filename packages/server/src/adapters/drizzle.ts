// noqa: SIZE_OK - Existing Drizzle adapter module; splitting belongs to a dedicated adapter cleanup.
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
  bundleRecordToRow,
  type BundleEventRow,
  type BundlePatchRow,
  type BundleRow,
  databaseBundleEventToRow,
  parseBundlePatchRow,
  parseBundlePatchRows,
  rowToDatabaseBundleEvent,
  rowToDatabaseBundleRecord,
  rowToBundle,
} from "../db/bundleRows";
import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
} from "../db/schema/registry";
import { generateDrizzleSchema } from "../db/schemaGenerators";
import type {
  DatabaseAdapterRuntime,
  ORMProvider,
  ORMSQLProvider,
  SchemaGenerator,
} from "../db/types";
import {
  createLazyDB,
  type DrizzleDB,
  type DrizzleTable,
  hasDrizzleTransaction,
} from "./drizzleLazyDB";
import { createCallbackDatabaseTransaction } from "./transaction";

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
  if (where?.id?.eq !== undefined)
    conditions.push(eq(column(table, "id"), where.id.eq));
  if (where?.id?.gt !== undefined)
    conditions.push(gt(column(table, "id"), where.id.gt));
  if (where?.id?.gte !== undefined)
    conditions.push(gte(column(table, "id"), where.id.gte));
  if (where?.id?.lt !== undefined)
    conditions.push(lt(column(table, "id"), where.id.lt));
  if (where?.id?.lte !== undefined)
    conditions.push(lte(column(table, "id"), where.id.lte));
  if (where?.id?.in !== undefined)
    conditions.push(inArray(column(table, "id"), where.id.in));
  return conditions.length > 0 ? and(...conditions) : undefined;
};

const hasEmptyBundleFilter = (where: DatabaseBundleQueryWhere | undefined) =>
  where?.id?.in?.length === 0 || where?.targetAppVersionIn?.length === 0;

const buildPatchWhere = (
  table: DrizzleTable,
  where: BundlePatchFindManyQuery["where"],
) => {
  const conditions = [];
  if (where?.id !== undefined)
    conditions.push(eq(column(table, "id"), where.id));
  if (where?.bundleId !== undefined)
    conditions.push(eq(column(table, "bundle_id"), where.bundleId));
  if (where?.baseBundleId !== undefined)
    conditions.push(eq(column(table, "base_bundle_id"), where.baseBundleId));
  if (where?.idIn?.length)
    conditions.push(inArray(column(table, "id"), [...where.idIn]));
  if (where?.bundleIdIn?.length)
    conditions.push(inArray(column(table, "bundle_id"), [...where.bundleIdIn]));
  if (where?.baseBundleIdIn?.length) {
    conditions.push(
      inArray(column(table, "base_bundle_id"), [...where.baseBundleIdIn]),
    );
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
};

const hasEmptyPatchFilter = (where: BundlePatchFindManyQuery["where"]) =>
  where?.idIn?.length === 0 ||
  where?.bundleIdIn?.length === 0 ||
  where?.baseBundleIdIn?.length === 0;

const buildEventWhere = (
  table: DrizzleTable,
  where: BundleEventFindManyQuery["where"],
) => {
  const conditions = [];
  if (where?.kind !== undefined)
    conditions.push(eq(column(table, "kind"), where.kind));
  if (where?.installId !== undefined)
    conditions.push(eq(column(table, "install_id"), where.installId));
  if (where?.activeBundleId !== undefined)
    conditions.push(
      eq(column(table, "active_bundle_id"), where.activeBundleId),
    );
  if (where?.previousActiveBundleId !== undefined) {
    conditions.push(
      eq(
        column(table, "previous_active_bundle_id"),
        where.previousActiveBundleId,
      ),
    );
  }
  if (where?.crashedBundleId !== undefined)
    conditions.push(
      eq(column(table, "crashed_bundle_id"), where.crashedBundleId),
    );
  if (where?.platform !== undefined)
    conditions.push(eq(column(table, "platform"), where.platform));
  if (where?.channel !== undefined)
    conditions.push(eq(column(table, "channel"), where.channel));
  if (where?.appVersion !== undefined)
    conditions.push(eq(column(table, "app_version"), where.appVersion));
  if (where?.fingerprintHash !== undefined)
    conditions.push(
      eq(column(table, "fingerprint_hash"), where.fingerprintHash),
    );
  if (where?.cohort !== undefined)
    conditions.push(eq(column(table, "cohort"), where.cohort));
  if (where?.userId !== undefined)
    conditions.push(eq(column(table, "user_id"), where.userId));
  return conditions.length > 0 ? and(...conditions) : undefined;
};

const patchOrderColumns = {
  id: "id",
  bundleId: "bundle_id",
  baseBundleId: "base_bundle_id",
  orderIndex: "order_index",
} as const;

const drizzleOrder = (
  value: SQLWrapper,
  direction: "asc" | "desc" | undefined,
) => (direction === "asc" ? asc(value) : desc(value));

const createDrizzlePlugin = createDatabasePlugin({
  name: "drizzle",
  connect: (config: DrizzleConfig): DatabasePluginDeclaration => {
    const db = createLazyDB(config);

    const createConnection = (
      activeDB: DrizzleDB,
    ): DatabasePluginDeclaration => {
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
          const patch = parseBundlePatchRow(row);
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

      const bundleStore: BundleStore = {
        async getById({ bundleId }) {
          const row = await activeDB.query["bundles"]?.findFirst({
            where: eq(column(bundleTable(), "id"), bundleId),
          });
          return row ? rowToDatabaseBundleRecord(row as BundleRow) : null;
        },
        async findRecords() {
          const rows = await activeDB.query["bundles"]?.findMany();
          return ((rows ?? []) as BundleRow[]).map(rowToDatabaseBundleRecord);
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
      };
      setBundleResourceOverride(bundleStore, {
        ...createBundleResource(bundleStore),
        async findMany({ where, window, orderBy }) {
          if (hasEmptyBundleFilter(where)) return [];
          const rows = await activeDB.query["bundles"]?.findMany({
            where: buildWhere(bundleTable(), where),
            orderBy: [
              drizzleOrder(column(bundleTable(), "id"), orderBy?.direction),
            ],
            limit: window.limit,
            offset: window.offset,
          });
          return ((rows ?? []) as BundleRow[]).map(rowToDatabaseBundleRecord);
        },
        async count({ where }) {
          if (hasEmptyBundleFilter(where)) return 0;
          return activeDB.$count(
            bundleTable(),
            buildWhere(bundleTable(), where),
          );
        },
      });

      const patchStore: BundlePatchRowStore & { readonly storage: "rows" } = {
        storage: "rows",
        async findRows() {
          const rows = await activeDB.query["bundle_patches"]?.findMany({
            orderBy: [asc(column(patchTable(), "order_index"))],
          });
          return parseBundlePatchRows(rows ?? []);
        },
        async getRowById({ patchId }) {
          const row = await activeDB.query["bundle_patches"]?.findFirst({
            where: eq(column(patchTable(), "id"), patchId),
          });
          return row ? parseBundlePatchRow(row) : null;
        },
        async insertRow({ row }) {
          const { id: _id, ...updateRow } = row;
          const inserted = activeDB.insert(patchTable()).values(row);
          if (config.provider === "mysql") {
            if (!inserted.onDuplicateKeyUpdate) {
              throw new Error(
                "Drizzle MySQL insert does not support duplicate-key handling.",
              );
            }
            await inserted.onDuplicateKeyUpdate({ set: updateRow });
          } else {
            if (!inserted.onConflictDoUpdate) {
              throw new Error(
                "Drizzle insert does not support conflict updates.",
              );
            }
            await inserted.onConflictDoUpdate({
              target: column(patchTable(), "id"),
              set: updateRow,
            });
          }
        },
        async updateRow({ patchId, row }) {
          await activeDB
            .update(patchTable())
            .set(row)
            .where(eq(column(patchTable(), "id"), patchId));
        },
        async deleteRow({ patchId }) {
          await activeDB
            .delete(patchTable())
            .where(eq(column(patchTable(), "id"), patchId));
        },
      };
      setBundlePatchResourceOverride(patchStore, {
        ...buildBundlePatchRowResource(patchStore),
        async findMany({ where, window, orderBy }) {
          if (hasEmptyPatchFilter(where)) return [];
          const direction = orderBy?.direction ?? "asc";
          const orderField = patchOrderColumns[orderBy?.field ?? "orderIndex"];
          const rows = await activeDB.query["bundle_patches"]?.findMany({
            where: buildPatchWhere(patchTable(), where),
            orderBy: [
              drizzleOrder(column(patchTable(), orderField), direction),
              ...(orderField === "id"
                ? []
                : [drizzleOrder(column(patchTable(), "id"), direction)]),
            ],
            limit: window.limit,
            offset: window.offset,
          });
          return parseBundlePatchRows(rows ?? []).map(toPatch);
        },
        async count({ where }) {
          if (hasEmptyPatchFilter(where)) return 0;
          return activeDB.$count(
            patchTable(),
            buildPatchWhere(patchTable(), where),
          );
        },
      });

      const eventStore: BundleEventStore = {
        async findEvents() {
          const rows = await activeDB.query["bundle_events"]?.findMany();
          return ((rows ?? []) as BundleEventRow[]).map(
            rowToDatabaseBundleEvent,
          );
        },
        async append({ event }) {
          const inserted = activeDB
            .insert(eventTable())
            .values(databaseBundleEventToRow(event));
          if (config.provider === "mysql") {
            if (!inserted.onDuplicateKeyUpdate) {
              throw new Error(
                "Drizzle MySQL insert does not support duplicate-key handling.",
              );
            }
            await inserted.onDuplicateKeyUpdate({ set: { id: event.id } });
          } else {
            if (!inserted.onConflictDoNothing) {
              throw new Error(
                "Drizzle insert does not support conflict handling.",
              );
            }
            await inserted.onConflictDoNothing();
          }
        },
        async deleteBeforeId({ beforeId }) {
          await activeDB
            .delete(eventTable())
            .where(lt(column(eventTable(), "id"), beforeId));
        },
      };
      setBundleEventResourceOverride(eventStore, {
        ...createBundleEventResource(eventStore),
        async findMany({ where, window, orderBy }) {
          const rows = await activeDB.query["bundle_events"]?.findMany({
            where: buildEventWhere(eventTable(), where),
            orderBy: [
              drizzleOrder(column(eventTable(), "id"), orderBy?.direction),
            ],
            limit: window.limit,
            offset: window.offset,
          });
          return ((rows ?? []) as BundleEventRow[]).map(
            rowToDatabaseBundleEvent,
          );
        },
        async count({ where }) {
          return activeDB.$count(
            eventTable(),
            buildEventWhere(eventTable(), where),
          );
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

    const connection = createConnection(db);
    if (!hasDrizzleTransaction(db)) {
      return connection;
    }
    const runTransaction = db.transaction;

    return {
      ...connection,
      beginTransaction: () =>
        createCallbackDatabaseTransaction<DrizzleDB>({
          createConnection,
          run: (operation) => runTransaction.call(db, operation),
        }),
    };
  },
});

export const createDrizzleDatabase = (
  config: DrizzleConfig,
): DatabaseAdapterRuntime => {
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

export const drizzleDatabase = createDrizzleDatabase;
export const drizzleAdapter = drizzleDatabase;
