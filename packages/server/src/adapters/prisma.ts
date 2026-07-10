// noqa: SIZE_OK - Existing Prisma adapter module; splitting belongs to a dedicated adapter cleanup.
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

      return {
        bundles: {
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
        },
        patches: {
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
        },
        bundleEvents: {
          async findEvents() {
            const events = getDelegate(client, "bundle_events");
            const rows = await events.findMany();
            return rows.map((row) =>
              rowToDatabaseBundleEvent(row as BundleEventRow),
            );
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
