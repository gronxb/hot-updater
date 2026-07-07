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
  bundleEventMatchesWhere,
  bundleRecordToRow,
  type BundleEventRow,
  type BundlePatchRow,
  type BundleRow,
  databaseBundleEventToRow,
  databaseBundlePatchToRow,
  databaseBundlePatchUpdateToRow,
  rowToDatabaseBundleEvent,
  rowToDatabaseBundlePatch,
  rowToDatabaseBundleRecord,
  rowToBundle,
} from "../db/bundleRows";
import {
  getHotUpdaterSchemaVersion,
  hotUpdaterSchema,
} from "../db/schema/registry";
import { generatePrismaSchema } from "../db/schemaGenerators";
import type {
  DatabaseAdapterCapabilities,
  ORMProvider,
  SchemaGenerator,
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

const prismaWhere = (where: DatabaseBundleQueryWhere | undefined) => {
  const targetAppVersionFilters = [];
  if (where?.targetAppVersion !== undefined) {
    targetAppVersionFilters.push({
      target_app_version: where.targetAppVersion,
    });
  }
  if (where?.targetAppVersionIn) {
    targetAppVersionFilters.push({
      target_app_version: { in: where.targetAppVersionIn },
    });
  }
  if (where?.targetAppVersionNotNull) {
    targetAppVersionFilters.push({
      target_app_version: { not: null },
    });
  }

  return {
    ...(where?.channel !== undefined ? { channel: where.channel } : {}),
    ...(where?.platform !== undefined ? { platform: where.platform } : {}),
    ...(where?.enabled !== undefined ? { enabled: where.enabled } : {}),
    ...(where?.fingerprintHash !== undefined
      ? { fingerprint_hash: where.fingerprintHash }
      : {}),
    ...(where?.id
      ? {
          id: {
            ...(where.id.eq !== undefined ? { equals: where.id.eq } : {}),
            ...(where.id.gt !== undefined ? { gt: where.id.gt } : {}),
            ...(where.id.gte !== undefined ? { gte: where.id.gte } : {}),
            ...(where.id.lt !== undefined ? { lt: where.id.lt } : {}),
            ...(where.id.lte !== undefined ? { lte: where.id.lte } : {}),
            ...(where.id.in !== undefined ? { in: where.id.in } : {}),
          },
        }
      : {}),
    ...(targetAppVersionFilters.length > 0
      ? { AND: targetAppVersionFilters }
      : {}),
  };
};

const createPrismaPlugin = createDatabasePlugin({
  name: "prisma",
  connect: (config: PrismaConfig): DatabasePluginCore => {
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
    const createCore = (
      client: Record<string, unknown>,
    ): DatabasePluginCore => {
      const fetchPatchMap = async (bundleIds: readonly string[]) => {
        const patches = getDelegate(client, "bundle_patches");
        const patchMap = new Map<string, BundlePatchRow[]>();
        if (bundleIds.length === 0) return patchMap;
        const rows = await patches.findMany({
          where: { bundle_id: { in: [...bundleIds] } },
          orderBy: { order_index: "asc" },
        });
        for (const row of rows) {
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
            const bundles = getDelegate(client, "bundles");
            const row = await bundles.findFirst({ where: { id: bundleId } });
            return row ? rowToDatabaseBundleRecord(row as BundleRow) : null;
          },
          async findMany({ where, orderBy, window }) {
            const bundles = getDelegate(client, "bundles");
            const bundleOrder = orderBy ?? {
              field: "id",
              direction: "desc",
            };
            const rows = await bundles.findMany({
              where: prismaWhere(where),
              orderBy: { id: bundleOrder.direction },
              skip: window.offset,
              take: window.limit,
            });
            return (rows as BundleRow[]).map(rowToDatabaseBundleRecord);
          },
          async count({ where }) {
            const bundles = getDelegate(client, "bundles");
            return bundles.count({ where: prismaWhere(where) });
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
        },
        bundlePatches: {
          async findMany({ where, orderBy, window }) {
            const patches = getDelegate(client, "bundle_patches");
            const rows = await patches.findMany({
              orderBy: { order_index: "asc" },
            });
            const data = rows
              .map((row) => rowToDatabaseBundlePatch(row as BundlePatchRow))
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
            return data.slice(window.offset, window.offset + window.limit);
          },
          async count({ where }) {
            const patches = getDelegate(client, "bundle_patches");
            const rows = await patches.findMany({
              orderBy: { order_index: "asc" },
            });
            return rows
              .map((row) => rowToDatabaseBundlePatch(row as BundlePatchRow))
              .filter((patch) => patchMatchesWhere(patch, where)).length;
          },
          async getById({ patchId }) {
            const patches = getDelegate(client, "bundle_patches");
            const row = await patches.findFirst({ where: { id: patchId } });
            return row ? rowToDatabaseBundlePatch(row as BundlePatchRow) : null;
          },
          async insert({ patch }) {
            const patches = getDelegate(client, "bundle_patches");
            await patches.createMany({
              data: [databaseBundlePatchToRow(patch)],
            });
          },
          async update({ patchId, patch }) {
            const patches = getDelegate(client, "bundle_patches");
            await patches.update({
              where: { id: patchId },
              data: databaseBundlePatchUpdateToRow(patch),
            });
          },
          async delete({ patchId }) {
            const patches = getDelegate(client, "bundle_patches");
            await patches.deleteMany({ where: { id: patchId } });
          },
        },
        bundleEvents: {
          async findMany({ where, orderBy, window }) {
            const events = getDelegate(client, "bundle_events");
            const rows = await events.findMany({
              orderBy: { id: orderBy?.direction ?? "desc" },
            });
            return rows
              .map((row) => rowToDatabaseBundleEvent(row as BundleEventRow))
              .filter((event) => bundleEventMatchesWhere(event, where))
              .slice(window.offset, window.offset + window.limit);
          },
          async count({ where }) {
            const events = getDelegate(client, "bundle_events");
            const rows = await events.findMany();
            return rows
              .map((row) => rowToDatabaseBundleEvent(row as BundleEventRow))
              .filter((event) => bundleEventMatchesWhere(event, where)).length;
          },
          async append({ event }) {
            const events = getDelegate(client, "bundle_events");
            await events.createMany({
              data: [databaseBundleEventToRow(event)],
            });
          },
        },
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

    const core = createCore(prisma);
    const runTransaction = prisma.$transaction;
    if (typeof runTransaction !== "function") {
      return core;
    }

    return {
      ...core,
      beginTransaction: () =>
        createCallbackDatabaseTransaction<Record<string, unknown>>({
          createCore,
          run: (operation) => runTransaction.call(prisma, operation),
        }),
    };
  },
});

export const prismaAdapter = (
  config: PrismaConfig,
): DatabaseAdapterCapabilities & DatabasePluginRuntime => {
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
