import { NIL_UUID } from "@hot-updater/core";
import type {
  Bundle,
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
    const bundleTable = () => getTable(db, "bundles");
    const patchTable = () => getTable(db, "bundle_patches");
    const eventTable = () => getTable(db, "bundle_events");

    const fetchPatchMap = async (bundleIds: readonly string[]) => {
      const patchMap = new Map<string, BundlePatchRow[]>();
      if (bundleIds.length === 0) return patchMap;
      const rows = await db.query["bundle_patches"]?.findMany({
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
    const upsertBundleRecord = async (
      activeDB: DrizzleDB,
      bundle: DatabaseBundleRecord,
    ) => {
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
    const replacePatchesForBundle = async (
      activeDB: DrizzleDB,
      bundleId: string,
      newPatches: readonly DatabaseBundlePatch[],
    ) => {
      await activeDB
        .delete(patchTable())
        .where(eq(column(patchTable(), "bundle_id"), bundleId));
      const patchRows = newPatches.map(databaseBundlePatchToRow);
      if (patchRows.length > 0) {
        const inserted = activeDB.insert(patchTable()).values(patchRows);
        if (inserted.execute) await inserted.execute();
        else await inserted;
      }
    };
    return {
      bundles: {
        async getById({ bundleId }) {
          const row = await db.query["bundles"]?.findFirst({
            where: eq(column(bundleTable(), "id"), bundleId),
          });
          return row ? rowToDatabaseBundleRecord(row as BundleRow) : null;
        },
        async list(options) {
          const orderBy = options.orderBy ?? { field: "id", direction: "desc" };
          const where = buildWhere(bundleTable(), options.where);
          const rows = await db.query["bundles"]?.findMany({
            where,
            orderBy: [
              orderBy.direction === "asc"
                ? asc(column(bundleTable(), "id"))
                : desc(column(bundleTable(), "id")),
            ],
          });
          const page = paginateCursorItems({
            items: (rows ?? []) as BundleRow[],
            limit: options.limit,
            cursor: options.cursor,
            offset: options.page
              ? (Math.max(1, options.page) - 1) * options.limit
              : undefined,
            getCursor: (row) => row.id,
          });
          return {
            ...page,
            data: page.data.map(rowToDatabaseBundleRecord),
          };
        },
        async insert({ bundle }) {
          await upsertBundleRecord(db, bundle);
        },
        async update({ bundleId, patch }) {
          const row = await db.query["bundles"]?.findFirst({
            where: eq(column(bundleTable(), "id"), bundleId),
          });
          if (!row) throw new Error("targetBundleId not found");
          await upsertBundleRecord(db, {
            ...rowToDatabaseBundleRecord(row as BundleRow),
            ...patch,
            id: bundleId,
          });
        },
        async delete({ bundleId }) {
          await db
            .delete(bundleTable())
            .where(eq(column(bundleTable(), "id"), bundleId));
        },
      },
      bundlePatches: {
        async list(options) {
          const rows = await db.query["bundle_patches"]?.findMany({
            orderBy: [asc(column(patchTable(), "order_index"))],
          });
          const patchRows = ((rows ?? []) as BundlePatchRow[])
            .map(rowToDatabaseBundlePatch)
            .filter((patch) => {
              const where = options.where;
              return (
                !where ||
                ((where.bundleId === undefined ||
                  patch.bundleId === where.bundleId) &&
                  (where.baseBundleId === undefined ||
                    patch.baseBundleId === where.baseBundleId) &&
                  (where.bundleIdIn === undefined ||
                    where.bundleIdIn.includes(patch.bundleId)) &&
                  (where.baseBundleIdIn === undefined ||
                    where.baseBundleIdIn.includes(patch.baseBundleId)))
              );
            })
            .sort((left, right) => {
              const direction = options.orderBy?.direction ?? "asc";
              const field = options.orderBy?.field ?? "orderIndex";
              const result =
                field === "orderIndex"
                  ? left.orderIndex - right.orderIndex
                  : left[field].localeCompare(right[field]);
              return direction === "asc" ? result : -result;
            });
          return paginateCursorItems({
            items: patchRows,
            limit: options.limit,
            cursor: options.cursor,
            getCursor: (patch) =>
              patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
          });
        },
        async replaceForBundle({ bundleId, patches }) {
          await replacePatchesForBundle(db, bundleId, patches);
        },
        async deleteForBundle({ bundleId }) {
          await db
            .delete(patchTable())
            .where(eq(column(patchTable(), "bundle_id"), bundleId));
        },
        async deleteForBaseBundle({ baseBundleId }) {
          await db
            .delete(patchTable())
            .where(eq(column(patchTable(), "base_bundle_id"), baseBundleId));
        },
      },
      bundleEvents: {
        async list(options) {
          const rows = await db.query["bundle_events"]?.findMany({
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
          const inserted = db
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
            const rows = await db.query["bundles"]?.findMany({
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
                ? await db.query["bundles"]?.findMany({
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
          const rows = await db.query["bundles"]?.findMany({
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
