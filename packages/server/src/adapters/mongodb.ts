import type {
  Bundle,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import type { Collection, Filter, MongoClient } from "mongodb";

import {
  bundleToPatchRows,
  bundleToRow,
  type BundlePatchRow,
  type BundleRow,
  rowToBundle,
} from "../db/bundleRows";
import { createMongoMigrator } from "../db/fixedMigrator";
import type { DatabasePluginFactory } from "../db/types";

export interface MongoDBConfig {
  readonly client: MongoClient;
}

const mongoWhere = (
  where: DatabaseBundleQueryWhere | undefined,
): Filter<BundleRow> => ({
  ...(where?.channel !== undefined ? { channel: where.channel } : {}),
  ...(where?.platform !== undefined ? { platform: where.platform } : {}),
  ...(where?.enabled !== undefined ? { enabled: where.enabled } : {}),
  ...(where?.fingerprintHash !== undefined
    ? where.fingerprintHash === null
      ? { fingerprint_hash: { $in: [null, ""] } }
      : { fingerprint_hash: where.fingerprintHash }
    : {}),
  ...(where?.targetAppVersion !== undefined
    ? where.targetAppVersion === null
      ? { target_app_version: { $in: [null, ""] } }
      : { target_app_version: where.targetAppVersion }
    : {}),
  ...(where?.targetAppVersionIn
    ? { target_app_version: { $in: where.targetAppVersionIn } }
    : {}),
  ...(where?.targetAppVersionNotNull
    ? { target_app_version: { $exists: true, $nin: [null, ""] } }
    : {}),
  ...(where?.id
    ? {
        id: {
          ...(where.id.eq !== undefined ? { $eq: where.id.eq } : {}),
          ...(where.id.gt !== undefined ? { $gt: where.id.gt } : {}),
          ...(where.id.gte !== undefined ? { $gte: where.id.gte } : {}),
          ...(where.id.lt !== undefined ? { $lt: where.id.lt } : {}),
          ...(where.id.lte !== undefined ? { $lte: where.id.lte } : {}),
          ...(where.id.in !== undefined ? { $in: where.id.in } : {}),
        },
      }
    : {}),
});

const createMongoPlugin = createDatabasePlugin<MongoDBConfig>({
  name: "mongodb",
  factory: ({ client }) => {
    const db = client.db();
    const bundles = db.collection<BundleRow>("bundles");
    const patches = db.collection<BundlePatchRow>("bundle_patches");
    const fetchPatchMap = async (bundleIds: readonly string[]) => {
      const patchMap = new Map<string, BundlePatchRow[]>();
      if (bundleIds.length === 0) return patchMap;
      const rows = await patches
        .find({ bundle_id: { $in: [...bundleIds] } })
        .sort({ order_index: 1 })
        .toArray();
      for (const row of rows) {
        const current = patchMap.get(row.bundle_id) ?? [];
        current.push(row);
        patchMap.set(row.bundle_id, current);
      }
      return patchMap;
    };
    const replaceBundle = async (bundle: Bundle) => {
      const row = bundleToRow(bundle);
      await bundles.updateOne(
        { id: bundle.id },
        { $set: row },
        { upsert: true },
      );
      await patches.deleteMany({ bundle_id: bundle.id });
      const patchRows = bundleToPatchRows(bundle);
      if (patchRows.length > 0) await patches.insertMany(patchRows);
    };
    const deleteByBundleId = async (
      collection: Collection<BundlePatchRow>,
      field: "bundle_id" | "base_bundle_id",
      bundleId: string,
    ) => {
      await collection.deleteMany({ [field]: bundleId });
    };
    return {
      async getBundleById(bundleId) {
        const row = await bundles.findOne({ id: bundleId });
        if (!row) return null;
        const patchMap = await fetchPatchMap([bundleId]);
        return rowToBundle(row, patchMap.get(bundleId) ?? []);
      },
      async getBundles(
        options: DatabaseBundleQueryOptions & { offset?: number },
      ) {
        const offset = options.offset ?? 0;
        const orderBy = options.orderBy ?? { field: "id", direction: "desc" };
        const where = mongoWhere(options.where);
        const [total, rows] = await Promise.all([
          bundles.countDocuments(where),
          bundles
            .find(where)
            .sort({ id: orderBy.direction === "asc" ? 1 : -1 })
            .skip(offset)
            .limit(options.limit)
            .toArray(),
        ]);
        const patchMap = await fetchPatchMap(rows.map((row) => row.id));
        return {
          data: rows.map((row) => rowToBundle(row, patchMap.get(row.id) ?? [])),
          pagination: calculatePagination(total, {
            limit: options.limit,
            offset,
          }),
        };
      },
      async getChannels() {
        const channels = await bundles.distinct("channel");
        return channels
          .filter((channel): channel is string => typeof channel === "string")
          .sort((left, right) => left.localeCompare(right));
      },
      async commitBundle({ changedSets }) {
        for (const change of changedSets) {
          if (change.operation === "delete") {
            await deleteByBundleId(patches, "bundle_id", change.data.id);
            await deleteByBundleId(patches, "base_bundle_id", change.data.id);
            await bundles.deleteMany({ id: change.data.id });
            continue;
          }
          await replaceBundle(change.data);
        }
      },
    };
  },
});

export const mongoAdapter = (config: MongoDBConfig): DatabasePluginFactory => {
  return Object.assign(createMongoPlugin(config), {
    adapterName: "mongodb",
    provider: "mongodb" as const,
    createMigrator: () => createMongoMigrator(config.client),
  });
};
