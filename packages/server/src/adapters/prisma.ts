import type {
  Bundle,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";

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
} from "../db/hotUpdaterSchema";
import { generatePrismaSchema } from "../db/schemaGenerators";
import type {
  DatabasePluginFactory,
  ORMProvider,
  SchemaGenerator,
} from "../db/types";

type PrismaRelationMode = "prisma" | "foreign-keys";

type PrismaDelegate = {
  readonly count: (args?: unknown) => Promise<number>;
  readonly createMany: (args: unknown) => Promise<unknown>;
  readonly deleteMany: (args?: unknown) => Promise<unknown>;
  readonly findFirst: (
    args?: unknown,
  ) => Promise<Record<string, unknown> | null>;
  readonly findMany: (args?: unknown) => Promise<Record<string, unknown>[]>;
  readonly upsert: (args: unknown) => Promise<unknown>;
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
  model: "bundles" | "bundle_patches",
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

const createPrismaPlugin = createDatabasePlugin<PrismaConfig>({
  name: "prisma",
  factory: (config) => {
    const prisma = config.prisma as Record<string, unknown>;
    const bundles = getDelegate(prisma, "bundles");
    const patches = getDelegate(prisma, "bundle_patches");
    const fetchPatchMap = async (bundleIds: readonly string[]) => {
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
    const upsertBundle = async (bundle: Bundle) => {
      const row = bundleToRow(bundle);
      const { id, ...update } = row;
      await bundles.upsert({
        where: { id },
        create: row,
        update,
      });
      await patches.deleteMany({ where: { bundle_id: id } });
      const patchRows = bundleToPatchRows(bundle);
      if (patchRows.length > 0) {
        await patches.createMany({ data: patchRows });
      }
    };
    return {
      async getBundleById(bundleId) {
        const row = await bundles.findFirst({ where: { id: bundleId } });
        if (!row) return null;
        const patchMap = await fetchPatchMap([bundleId]);
        return rowToBundle(row as BundleRow, patchMap.get(bundleId) ?? []);
      },
      async getBundles(
        options: DatabaseBundleQueryOptions & { offset?: number },
      ) {
        const offset = options.offset ?? 0;
        const orderBy = options.orderBy ?? { field: "id", direction: "desc" };
        const where = prismaWhere(options.where);
        const [total, rows] = await Promise.all([
          bundles.count({ where }),
          bundles.findMany({
            where,
            orderBy: { id: orderBy.direction },
            skip: offset,
            take: options.limit,
          }),
        ]);
        const patchMap = await fetchPatchMap(
          rows.map((row) => String(row["id"])),
        );
        return {
          data: rows.map((row) =>
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
      async getChannels() {
        const rows = await bundles.findMany({
          select: { channel: true },
          orderBy: { channel: "asc" },
        });
        return Array.from(new Set(rows.map((row) => String(row["channel"]))));
      },
      async commitBundle({ changedSets }) {
        for (const change of changedSets) {
          if (change.operation === "delete") {
            await patches.deleteMany({ where: { bundle_id: change.data.id } });
            await patches.deleteMany({
              where: { base_bundle_id: change.data.id },
            });
            await bundles.deleteMany({ where: { id: change.data.id } });
            continue;
          }
          await upsertBundle(change.data);
        }
      },
    };
  },
});

export const prismaAdapter = (config: PrismaConfig): DatabasePluginFactory => {
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
