// noqa: SIZE_OK - Existing Prisma adapter module; splitting belongs to a dedicated adapter cleanup.
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
import { generatePrismaSchema } from "../db/schemaGenerators";
import type {
  DatabaseAdapterRuntime,
  ORMProvider,
  SchemaGenerator,
} from "../db/types";
import { createCallbackDatabaseTransaction } from "./transaction";

type PrismaRelationMode = "prisma" | "foreign-keys";

type PrismaDelegate = {
  readonly count: (args?: unknown) => Promise<number>;
  readonly createMany: (args: unknown) => Promise<unknown>;
  readonly deleteMany: (args?: unknown) => Promise<unknown>;
  readonly findFirst: (
    args?: unknown,
  ) => Promise<Record<string, unknown> | null>;
  readonly findMany: (args?: unknown) => Promise<Record<string, unknown>[]>;
  readonly update: (args: unknown) => Promise<unknown>;
  readonly upsert: (args: unknown) => Promise<unknown>;
};

type PrismaClient = Record<string, unknown> & {
  readonly $transaction?: <T>(
    operation: (tx: Record<string, unknown>) => Promise<T>,
  ) => Promise<T>;
};

export interface PrismaConfig {
  readonly prisma: object;
  readonly provider: ORMProvider;
  readonly relationMode?: PrismaRelationMode;
  readonly db?: unknown;
}

const assertSupportedRelationMode = (
  relationMode: PrismaRelationMode | undefined,
) => {
  if (
    relationMode &&
    relationMode !== "prisma" &&
    relationMode !== "foreign-keys"
  ) {
    throw new Error(`Unsupported Prisma relation mode: ${relationMode}`);
  }
};

const getDelegate = (
  prisma: Record<string, unknown>,
  model: "bundles" | "bundle_patches" | "bundle_events",
): PrismaDelegate => {
  const delegate = prisma[model];
  if (!delegate || typeof delegate !== "object") {
    throw new Error(`Prisma client is missing model delegate "${model}".`);
  }
  return delegate as PrismaDelegate;
};

const hasEmptyBundleFilter = (where: DatabaseBundleQueryWhere | undefined) =>
  where?.id?.in?.length === 0 || where?.targetAppVersionIn?.length === 0;

const buildPrismaStringFilter = (
  equals: string | null | undefined,
  values: readonly string[] | undefined,
  notNull: boolean,
): string | null | Record<string, unknown> | undefined => {
  if (values === undefined && !notNull) return equals;
  const filter: Record<string, unknown> = {};
  if (equals !== undefined) filter["equals"] = equals;
  if (values !== undefined) filter["in"] = [...values];
  if (notNull) filter["not"] = null;
  return filter;
};

const buildPrismaBundleWhere = (
  where: DatabaseBundleQueryWhere | undefined,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  if (!where) return result;
  if (where.channel !== undefined) result["channel"] = where.channel;
  if (where.platform !== undefined) result["platform"] = where.platform;
  if (where.enabled !== undefined) result["enabled"] = where.enabled;
  if (where.fingerprintHash !== undefined)
    result["fingerprint_hash"] = where.fingerprintHash;

  const targetAppVersion = buildPrismaStringFilter(
    where.targetAppVersion,
    where.targetAppVersionIn,
    where.targetAppVersionNotNull === true,
  );
  if (targetAppVersion !== undefined)
    result["target_app_version"] = targetAppVersion;

  if (where.id) {
    const id: Record<string, unknown> = {};
    if (where.id.eq !== undefined) id["equals"] = where.id.eq;
    if (where.id.gt !== undefined) id["gt"] = where.id.gt;
    if (where.id.gte !== undefined) id["gte"] = where.id.gte;
    if (where.id.lt !== undefined) id["lt"] = where.id.lt;
    if (where.id.lte !== undefined) id["lte"] = where.id.lte;
    if (where.id.in !== undefined) id["in"] = [...where.id.in];
    result["id"] = id;
  }
  return result;
};

const hasEmptyPatchFilter = (where: BundlePatchFindManyQuery["where"]) =>
  where?.idIn?.length === 0 ||
  where?.bundleIdIn?.length === 0 ||
  where?.baseBundleIdIn?.length === 0;

const buildPrismaPatchWhere = (
  where: BundlePatchFindManyQuery["where"],
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  if (!where) return result;
  const id = buildPrismaStringFilter(where.id, where.idIn, false);
  if (id !== undefined) result["id"] = id;
  const bundleId = buildPrismaStringFilter(
    where.bundleId,
    where.bundleIdIn,
    false,
  );
  if (bundleId !== undefined) result["bundle_id"] = bundleId;
  const baseBundleId = buildPrismaStringFilter(
    where.baseBundleId,
    where.baseBundleIdIn,
    false,
  );
  if (baseBundleId !== undefined) result["base_bundle_id"] = baseBundleId;
  return result;
};

const buildPrismaEventWhere = (
  where: BundleEventFindManyQuery["where"],
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  if (!where) return result;
  if (where.kind !== undefined) result["kind"] = where.kind;
  if (where.installId !== undefined) result["install_id"] = where.installId;
  if (where.activeBundleId !== undefined)
    result["active_bundle_id"] = where.activeBundleId;
  if (where.previousActiveBundleId !== undefined)
    result["previous_active_bundle_id"] = where.previousActiveBundleId;
  if (where.crashedBundleId !== undefined)
    result["crashed_bundle_id"] = where.crashedBundleId;
  if (where.platform !== undefined) result["platform"] = where.platform;
  if (where.channel !== undefined) result["channel"] = where.channel;
  if (where.appVersion !== undefined) result["app_version"] = where.appVersion;
  if (where.fingerprintHash !== undefined)
    result["fingerprint_hash"] = where.fingerprintHash;
  if (where.cohort !== undefined) result["cohort"] = where.cohort;
  if (where.userId !== undefined) result["user_id"] = where.userId;
  return result;
};

const patchOrderColumns = {
  id: "id",
  bundleId: "bundle_id",
  baseBundleId: "base_bundle_id",
  orderIndex: "order_index",
} as const;

const createPrismaPlugin = createDatabasePlugin({
  name: "prisma",
  connect: (config: PrismaConfig): DatabasePluginDeclaration => {
    const prisma = config.prisma as PrismaClient;

    const upsertBundleRecord = async (
      client: Record<string, unknown>,
      bundle: DatabaseBundleRecord,
    ) => {
      const bundles = getDelegate(client, "bundles");
      const row = bundleRecordToRow(bundle);
      const { id, ...update } = row;
      await bundles.upsert({
        where: { id },
        create: row,
        update,
      });
    };
    const createConnection = (
      client: Record<string, unknown>,
    ): DatabasePluginDeclaration => {
      const fetchPatchMap = async (bundleIds: readonly string[]) => {
        const patches = getDelegate(client, "bundle_patches");
        const patchMap = new Map<string, BundlePatchRow[]>();
        if (bundleIds.length === 0) return patchMap;
        const rows = await patches.findMany({
          where: { bundle_id: { in: [...bundleIds] } },
          orderBy: { order_index: "asc" },
        });
        for (const row of rows) {
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
          const bundles = getDelegate(client, "bundles");
          const row = await bundles.findFirst({ where: { id: bundleId } });
          return row ? rowToDatabaseBundleRecord(row as BundleRow) : null;
        },
        async findRecords() {
          const bundles = getDelegate(client, "bundles");
          const rows = await bundles.findMany();
          return (rows as BundleRow[]).map(rowToDatabaseBundleRecord);
        },
        async insert({ bundle }) {
          await upsertBundleRecord(client, bundle);
        },
        async update({ bundleId, patch }) {
          const bundles = getDelegate(client, "bundles");
          const row = await bundles.findFirst({ where: { id: bundleId } });
          if (!row) throw new Error("targetBundleId not found");
          await upsertBundleRecord(client, {
            ...rowToDatabaseBundleRecord(row as BundleRow),
            ...patch,
            id: bundleId,
          });
        },
        async delete({ bundleId }) {
          const bundles = getDelegate(client, "bundles");
          await bundles.deleteMany({ where: { id: bundleId } });
        },
      };
      setBundleResourceOverride(bundleStore, {
        ...createBundleResource(bundleStore),
        async findMany({ where, window, orderBy }) {
          if (hasEmptyBundleFilter(where)) return [];
          const bundles = getDelegate(client, "bundles");
          const rows = await bundles.findMany({
            where: buildPrismaBundleWhere(where),
            orderBy: { id: orderBy?.direction ?? "desc" },
            skip: window.offset,
            take: window.limit,
          });
          return (rows as BundleRow[]).map(rowToDatabaseBundleRecord);
        },
        async count({ where }) {
          if (hasEmptyBundleFilter(where)) return 0;
          return getDelegate(client, "bundles").count({
            where: buildPrismaBundleWhere(where),
          });
        },
      });

      const patchStore: BundlePatchRowStore & { readonly storage: "rows" } = {
        storage: "rows",
        async findRows() {
          const patches = getDelegate(client, "bundle_patches");
          const rows = await patches.findMany({
            orderBy: { order_index: "asc" },
          });
          return parseBundlePatchRows(rows);
        },
        async getRowById({ patchId }) {
          const patches = getDelegate(client, "bundle_patches");
          const row = await patches.findFirst({ where: { id: patchId } });
          return row ? parseBundlePatchRow(row) : null;
        },
        async insertRow({ row }) {
          const patches = getDelegate(client, "bundle_patches");
          await patches.createMany({
            data: [row],
          });
        },
        async updateRow({ patchId, row }) {
          const patches = getDelegate(client, "bundle_patches");
          await patches.update({
            where: { id: patchId },
            data: row,
          });
        },
        async deleteRow({ patchId }) {
          const patches = getDelegate(client, "bundle_patches");
          await patches.deleteMany({ where: { id: patchId } });
        },
      };
      setBundlePatchResourceOverride(patchStore, {
        ...buildBundlePatchRowResource(patchStore),
        async findMany({ where, window, orderBy }) {
          if (hasEmptyPatchFilter(where)) return [];
          const direction = orderBy?.direction ?? "asc";
          const orderField = patchOrderColumns[orderBy?.field ?? "orderIndex"];
          const rows = await getDelegate(client, "bundle_patches").findMany({
            where: buildPrismaPatchWhere(where),
            orderBy: [
              { [orderField]: direction },
              ...(orderField === "id" ? [] : [{ id: direction }]),
            ],
            skip: window.offset,
            take: window.limit,
          });
          return parseBundlePatchRows(rows).map(toPatch);
        },
        async count({ where }) {
          if (hasEmptyPatchFilter(where)) return 0;
          return getDelegate(client, "bundle_patches").count({
            where: buildPrismaPatchWhere(where),
          });
        },
      });

      const eventStore: BundleEventStore = {
        async findEvents() {
          const events = getDelegate(client, "bundle_events");
          const rows = await events.findMany();
          return rows.map((row) =>
            rowToDatabaseBundleEvent(row as BundleEventRow),
          );
        },
        async append({ event }) {
          const events = getDelegate(client, "bundle_events");
          const row = databaseBundleEventToRow(event);
          await events.upsert({
            where: { id: event.id },
            create: row,
            update: {},
          });
        },
        async deleteBeforeId({ beforeId }) {
          await getDelegate(client, "bundle_events").deleteMany({
            where: { id: { lt: beforeId } },
          });
        },
      };
      setBundleEventResourceOverride(eventStore, {
        ...createBundleEventResource(eventStore),
        async findMany({ where, window, orderBy }) {
          const rows = await getDelegate(client, "bundle_events").findMany({
            where: buildPrismaEventWhere(where),
            orderBy: { id: orderBy?.direction ?? "desc" },
            skip: window.offset,
            take: window.limit,
          });
          return rows.map((row) =>
            rowToDatabaseBundleEvent(row as BundleEventRow),
          );
        },
        async count({ where }) {
          return getDelegate(client, "bundle_events").count({
            where: buildPrismaEventWhere(where),
          });
        },
      });

      return {
        bundles: bundleStore,
        patches: patchStore,
        bundleEvents: eventStore,
        updateInfo: {
          async get(args) {
            const bundles = getDelegate(client, "bundles");

            if (args._updateStrategy === "appVersion") {
              const channel = args.channel ?? "production";
              const minBundleId = args.minBundleId ?? NIL_UUID;
              const rows = await bundles.findMany({
                select: { target_app_version: true },
                where: {
                  enabled: true,
                  platform: args.platform,
                  channel,
                  id: { gte: minBundleId },
                  target_app_version: { not: null },
                },
              });

              const targetAppVersions = Array.from(
                new Set(
                  rows
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
              const updateBundles =
                compatibleAppVersions.length > 0
                  ? await bundles
                      .findMany({
                        where: {
                          enabled: true,
                          platform: args.platform,
                          channel,
                          id: { gte: minBundleId },
                          target_app_version: { in: compatibleAppVersions },
                        },
                        orderBy: { id: "desc" },
                      })
                      .then(mapRowsToBundles)
                  : [];

              return resolveUpdateInfoFromBundles({
                args: { ...args, channel, minBundleId },
                bundles: updateBundles,
              });
            }

            const channel = args.channel ?? "production";
            const minBundleId = args.minBundleId ?? NIL_UUID;
            const rows = await bundles.findMany({
              where: {
                enabled: true,
                platform: args.platform,
                channel,
                id: { gte: minBundleId },
                fingerprint_hash: args.fingerprintHash,
              },
              orderBy: { id: "desc" },
            });

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles: await mapRowsToBundles(rows),
            });
          },
        },
      };
    };

    const connection = createConnection(prisma);
    const runTransaction = prisma.$transaction;
    if (typeof runTransaction !== "function") {
      return connection;
    }

    return {
      ...connection,
      beginTransaction: () =>
        createCallbackDatabaseTransaction<Record<string, unknown>>({
          createConnection,
          run: (operation) => runTransaction.call(prisma, operation),
        }),
    };
  },
});

export const createPrismaDatabase = (
  config: PrismaConfig,
): DatabaseAdapterRuntime => {
  assertSupportedRelationMode(config.relationMode);
  return Object.assign(createPrismaPlugin(config), {
    adapterName: "prisma",
    provider: config.provider,
    generateSchema: (version: Parameters<SchemaGenerator>[0]) => ({
      code: generatePrismaSchema(
        config.provider,
        version === "latest"
          ? hotUpdaterSchema
          : getHotUpdaterSchemaVersion(version),
      ),
      path: "./prisma/schema/hot_updater.prisma",
    }),
  });
};

export const prismaDatabase = createPrismaDatabase;
export const prismaAdapter = prismaDatabase;
