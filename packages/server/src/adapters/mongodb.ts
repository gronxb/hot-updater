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
import type { ClientSession, Collection, Filter, MongoClient } from "mongodb";

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
): Filter<BundleRow> => {
  const baseFilter: Filter<BundleRow> = {
    ...(where?.channel !== undefined ? { channel: where.channel } : {}),
    ...(where?.platform !== undefined ? { platform: where.platform } : {}),
    ...(where?.enabled !== undefined ? { enabled: where.enabled } : {}),
    ...(where?.fingerprintHash !== undefined
      ? where.fingerprintHash === null
        ? { fingerprint_hash: { $in: [null, ""] } }
        : { fingerprint_hash: where.fingerprintHash }
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
  };
  const targetAppVersionFilters: Filter<BundleRow>[] = [];
  if (where?.targetAppVersion !== undefined) {
    targetAppVersionFilters.push(
      where.targetAppVersion === null
        ? { target_app_version: { $in: [null, ""] } }
        : { target_app_version: where.targetAppVersion },
    );
  }
  if (where?.targetAppVersionIn) {
    targetAppVersionFilters.push({
      target_app_version: { $in: where.targetAppVersionIn },
    });
  }
  if (where?.targetAppVersionNotNull) {
    targetAppVersionFilters.push({
      target_app_version: { $exists: true, $nin: [null, ""] },
    });
  }

  const filters = [
    ...(Object.keys(baseFilter).length > 0 ? [baseFilter] : []),
    ...targetAppVersionFilters,
  ];
  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0] ?? {};
  return { $and: filters };
};

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
    const mapRowsToBundles = async (
      rows: readonly BundleRow[],
    ): Promise<Bundle[]> => {
      const patchMap = await fetchPatchMap(rows.map((row) => row.id));
      return rows.map((row) => rowToBundle(row, patchMap.get(row.id) ?? []));
    };
    const isTransactionUnsupported = (error: unknown): boolean =>
      error instanceof Error &&
      /Transaction numbers are only allowed|replica set member or mongos|Transaction API error/i.test(
        error.message,
      );
    const runInTransaction = async <T>(
      operation: (session: ClientSession | undefined) => Promise<T>,
    ) => {
      if (typeof client.startSession !== "function") {
        return operation(undefined);
      }
      const session = client.startSession();
      try {
        if (typeof session.withTransaction !== "function") {
          return await operation(session);
        }
        let result: T | undefined;
        await session.withTransaction(async () => {
          result = await operation(session);
        });
        return result as T;
      } catch (error) {
        if (isTransactionUnsupported(error)) {
          return operation(undefined);
        }
        throw error;
      } finally {
        await session.endSession();
      }
    };
    const replaceBundle = async (
      bundle: Bundle,
      session: ClientSession | undefined,
    ) => {
      const row = bundleToRow(bundle);
      await bundles.updateOne(
        { id: bundle.id },
        { $set: row },
        { session, upsert: true },
      );
      await patches.deleteMany({ bundle_id: bundle.id }, { session });
      const patchRows = bundleToPatchRows(bundle);
      if (patchRows.length > 0)
        await patches.insertMany(patchRows, { session });
    };
    const deleteByBundleId = async (
      collection: Collection<BundlePatchRow>,
      field: "bundle_id" | "base_bundle_id",
      bundleId: string,
      session: ClientSession | undefined,
    ) => {
      await collection.deleteMany({ [field]: bundleId }, { session });
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
      async getUpdateInfo(args, context) {
        if (args._updateStrategy === "appVersion") {
          const channel = args.channel ?? "production";
          const minBundleId = args.minBundleId ?? NIL_UUID;
          const rows = await bundles
            .find({
              enabled: true,
              platform: args.platform,
              channel,
              id: { $gte: minBundleId },
              target_app_version: { $exists: true, $nin: [null, ""] },
            })
            .project<{ target_app_version?: string | null }>({
              target_app_version: 1,
            })
            .toArray();

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
          const updateRows =
            compatibleAppVersions.length > 0
              ? await bundles
                  .find({
                    enabled: true,
                    platform: args.platform,
                    channel,
                    id: { $gte: minBundleId },
                    target_app_version: { $in: compatibleAppVersions },
                  })
                  .sort({ id: -1 })
                  .toArray()
              : [];

          return resolveUpdateInfoFromBundles({
            args: { ...args, channel, minBundleId },
            bundles: await mapRowsToBundles(updateRows),
            context,
          });
        }

        const channel = args.channel ?? "production";
        const minBundleId = args.minBundleId ?? NIL_UUID;
        const rows = await bundles
          .find({
            enabled: true,
            platform: args.platform,
            channel,
            id: { $gte: minBundleId },
            fingerprint_hash: args.fingerprintHash,
          })
          .sort({ id: -1 })
          .toArray();

        return resolveUpdateInfoFromBundles({
          args: { ...args, channel, minBundleId },
          bundles: await mapRowsToBundles(rows),
          context,
        });
      },
      async getChannels() {
        const channels = await bundles.distinct("channel");
        return channels
          .filter((channel): channel is string => typeof channel === "string")
          .sort((left, right) => left.localeCompare(right));
      },
      async commitBundle({ changedSets }) {
        await runInTransaction(async (session) => {
          for (const change of changedSets) {
            if (change.operation === "delete") {
              await deleteByBundleId(
                patches,
                "bundle_id",
                change.data.id,
                session,
              );
              await deleteByBundleId(
                patches,
                "base_bundle_id",
                change.data.id,
                session,
              );
              await bundles.deleteMany({ id: change.data.id }, { session });
              continue;
            }
            await replaceBundle(change.data, session);
          }
        });
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
