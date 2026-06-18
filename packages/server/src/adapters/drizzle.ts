import { NIL_UUID } from "@hot-updater/core";
import type {
  Bundle,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
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
  bundleToPatchRows,
  bundleToRow,
  type BundlePatchRow,
  type BundleRow,
  rowToBundle,
} from "../db/bundleRows";
import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
} from "../db/schema/registry";
import { generateDrizzleSchema } from "../db/schemaGenerators";
import type {
  DatabasePluginFactory,
  ORMProvider,
  ORMSQLProvider,
  SchemaGenerator,
} from "../db/types";
import {
  createLazyDb,
  type DrizzleDb,
  type DrizzleTable,
} from "./drizzleLazyDb";

export interface DrizzleConfig {
  readonly db: unknown | (() => unknown | Promise<unknown>);
  readonly provider: Exclude<ORMProvider, "cockroachdb" | "mongodb" | "mssql">;
  readonly schema?: Record<string, unknown>;
}

const getTable = (db: DrizzleDb, name: string) => {
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

const createDrizzlePlugin = createDatabasePlugin<DrizzleConfig>({
  name: "drizzle",
  factory: (config) => {
    const db = createLazyDb(config);
    const bundles = getTable(db, "bundles");
    const patches = getTable(db, "bundle_patches");
    const runInTransaction = async <T>(
      operation: (activeDb: DrizzleDb) => Promise<T>,
    ) => {
      if (typeof db.transaction !== "function") return operation(db);
      return db.transaction(operation);
    };
    const fetchPatchMap = async (bundleIds: readonly string[]) => {
      const patchMap = new Map<string, BundlePatchRow[]>();
      if (bundleIds.length === 0) return patchMap;
      const rows = await db.query["bundle_patches"]?.findMany({
        where: inArray(column(patches, "bundle_id"), [...bundleIds]),
        orderBy: [asc(column(patches, "order_index"))],
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
    const upsertBundle = async (activeDb: DrizzleDb, bundle: Bundle) => {
      const row = bundleToRow(bundle);
      const current = await activeDb.query["bundles"]?.findFirst({
        where: eq(column(bundles, "id"), bundle.id),
      });
      if (current) {
        await activeDb
          .update(bundles)
          .set(row)
          .where(eq(column(bundles, "id"), bundle.id));
      } else {
        const inserted = activeDb.insert(bundles).values(row);
        if (inserted.execute) await inserted.execute();
        else await inserted;
      }
      await activeDb
        .delete(patches)
        .where(eq(column(patches, "bundle_id"), bundle.id));
      const patchRows = bundleToPatchRows(bundle);
      if (patchRows.length > 0) {
        const inserted = activeDb.insert(patches).values(patchRows);
        if (inserted.execute) await inserted.execute();
        else await inserted;
      }
    };
    return {
      async getBundleById(bundleId) {
        const row = await db.query["bundles"]?.findFirst({
          where: eq(column(bundles, "id"), bundleId),
        });
        if (!row) return null;
        const patchMap = await fetchPatchMap([bundleId]);
        return rowToBundle(row as BundleRow, patchMap.get(bundleId) ?? []);
      },
      async getBundles(
        options: DatabaseBundleQueryOptions & { offset?: number },
      ) {
        const offset = options.offset ?? 0;
        const orderBy = options.orderBy ?? { field: "id", direction: "desc" };
        const where = buildWhere(bundles, options.where);
        const total = await db.$count(bundles, where);
        const rows = await db.query["bundles"]?.findMany({
          where,
          orderBy: [
            orderBy.direction === "asc"
              ? asc(column(bundles, "id"))
              : desc(column(bundles, "id")),
          ],
          limit: options.limit,
          offset,
        });
        const dataRows = rows ?? [];
        const patchMap = await fetchPatchMap(
          dataRows.map((row) => String(row["id"])),
        );
        return {
          data: dataRows.map((row) =>
            rowToBundle(
              row as BundleRow,
              patchMap.get(String(row["id"])) ?? [],
            ),
          ),
          pagination: calculatePagination(total, {
            limit: options.limit,
            offset,
          }),
        };
      },
      async getUpdateInfo(args, context) {
        if (args._updateStrategy === "appVersion") {
          const channel = args.channel ?? "production";
          const minBundleId = args.minBundleId ?? NIL_UUID;
          const rows = await db.query["bundles"]?.findMany({
            columns: { target_app_version: true },
            where: buildWhere(bundles, {
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
                  where: buildWhere(bundles, {
                    enabled: true,
                    platform: args.platform,
                    channel,
                    id: { gte: minBundleId },
                    targetAppVersionIn: compatibleAppVersions,
                  }),
                  orderBy: [desc(column(bundles, "id"))],
                })
              : [];

          return resolveUpdateInfoFromBundles({
            args: { ...args, channel, minBundleId },
            bundles: await mapRowsToBundles(updateRows ?? []),
            context,
          });
        }

        const channel = args.channel ?? "production";
        const minBundleId = args.minBundleId ?? NIL_UUID;
        const rows = await db.query["bundles"]?.findMany({
          where: buildWhere(bundles, {
            enabled: true,
            platform: args.platform,
            channel,
            id: { gte: minBundleId },
            fingerprintHash: args.fingerprintHash,
          }),
          orderBy: [desc(column(bundles, "id"))],
        });

        return resolveUpdateInfoFromBundles({
          args: { ...args, channel, minBundleId },
          bundles: await mapRowsToBundles(rows ?? []),
          context,
        });
      },
      async getChannels() {
        const rows = await db.query["bundles"]?.findMany({
          columns: { channel: true },
          orderBy: [asc(column(bundles, "channel"))],
        });
        return Array.from(
          new Set((rows ?? []).map((row) => String(row["channel"]))),
        );
      },
      async commitBundle({ changedSets }) {
        await runInTransaction(async (activeDb) => {
          for (const change of changedSets) {
            if (change.operation === "delete") {
              await activeDb
                .delete(patches)
                .where(eq(column(patches, "bundle_id"), change.data.id));
              await activeDb
                .delete(patches)
                .where(eq(column(patches, "base_bundle_id"), change.data.id));
              await activeDb
                .delete(bundles)
                .where(eq(column(bundles, "id"), change.data.id));
              continue;
            }
            await upsertBundle(activeDb, change.data);
          }
        });
      },
    };
  },
});

export const drizzleAdapter = (
  config: DrizzleConfig,
): DatabasePluginFactory => {
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
