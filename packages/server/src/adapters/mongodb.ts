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
import type { ClientSession, Filter, MongoClient } from "mongodb";

import {
  bundleRecordToRow,
  type BundlePatchRow,
  type BundleRow,
  databaseBundlePatchToRow,
  databaseBundlePatchUpdateToRow,
  paginateCursorItems,
  rowToDatabaseBundlePatch,
  rowToDatabaseBundleRecord,
  rowToBundle,
} from "../db/bundleRows";
import { createMongoMigrator } from "../db/fixedMigrator";
import type { DatabaseAdapterCapabilities } from "../db/types";
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

export interface MongoDBConfig {
  readonly client: MongoClient;
  /**
   * Enable only for deployments that support MongoDB multi-document
   * transactions, such as replica sets or sharded clusters.
   */
  readonly transactions?: "enabled";
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

const createMongoPlugin = createDatabasePlugin({
  name: "mongodb",
  connect: (config: MongoDBConfig): DatabasePluginCore => {
    const { client } = config;
    const db = client.db();
    const bundles = db.collection<BundleRow>("bundles");
    const patches = db.collection<BundlePatchRow>("bundle_patches");
    const createCore = (session?: ClientSession): DatabasePluginCore => {
      const sessionArgs = () =>
        session ? ([{ session }] as const) : ([] as const);
      const withSession = <TOptions extends object>(options: TOptions) =>
        session ? { ...options, session } : options;

      const fetchPatchMap = async (bundleIds: readonly string[]) => {
        const patchMap = new Map<string, BundlePatchRow[]>();
        if (bundleIds.length === 0) return patchMap;
        const rows = await patches
          .find({ bundle_id: { $in: [...bundleIds] } }, ...sessionArgs())
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
      const replaceBundleRecord = async (bundle: DatabaseBundleRecord) => {
        const row = bundleRecordToRow(bundle);
        await bundles.updateOne(
          { id: bundle.id },
          { $set: row },
          withSession({ upsert: true }),
        );
      };
      return {
        bundles: {
          async getById({ bundleId }) {
            const row = await bundles.findOne(
              { id: bundleId },
              ...sessionArgs(),
            );
            return row ? rowToDatabaseBundleRecord(row) : null;
          },
          async list(options) {
            const orderBy = options.orderBy ?? {
              field: "id",
              direction: "desc",
            };
            const rows = await bundles
              .find(mongoWhere(options.where), ...sessionArgs())
              .sort({ id: orderBy.direction === "asc" ? 1 : -1 })
              .toArray();
            const page = paginateCursorItems({
              items: rows,
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
            await replaceBundleRecord(bundle);
          },
          async update({ bundleId, patch }) {
            const row = await bundles.findOne(
              { id: bundleId },
              ...sessionArgs(),
            );
            if (!row) throw new Error("targetBundleId not found");
            await replaceBundleRecord({
              ...rowToDatabaseBundleRecord(row),
              ...patch,
              id: bundleId,
            });
          },
          async delete({ bundleId }) {
            await bundles.deleteMany({ id: bundleId }, ...sessionArgs());
          },
        },
        bundlePatches: {
          async list(options) {
            const rows = await patches
              .find({}, ...sessionArgs())
              .sort({ order_index: 1 })
              .toArray();
            const data = rows
              .map(rowToDatabaseBundlePatch)
              .filter((patch) => {
                const where = options.where;
                return (
                  !where ||
                  ((where.id === undefined || getPatchId(patch) === where.id) &&
                    (where.bundleId === undefined ||
                      patch.bundleId === where.bundleId) &&
                    (where.baseBundleId === undefined ||
                      patch.baseBundleId === where.baseBundleId) &&
                    (where.idIn === undefined ||
                      where.idIn.includes(getPatchId(patch))) &&
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
                    : getPatchStringField(left, field).localeCompare(
                        getPatchStringField(right, field),
                      );
                return direction === "asc" ? result : -result;
              });
            return paginateCursorItems({
              items: data,
              limit: options.limit,
              cursor: options.cursor,
              getCursor: getPatchId,
            });
          },
          async getById({ patchId }) {
            const row = await patches.findOne(
              { id: patchId },
              ...sessionArgs(),
            );
            return row ? rowToDatabaseBundlePatch(row) : null;
          },
          async insert({ patch }) {
            await patches.insertMany(
              [databaseBundlePatchToRow(patch)],
              ...sessionArgs(),
            );
          },
          async update({ patchId, patch }) {
            await patches.updateOne(
              { id: patchId },
              { $set: databaseBundlePatchUpdateToRow(patch) },
              ...sessionArgs(),
            );
          },
          async delete({ patchId }) {
            await patches.deleteMany({ id: patchId }, ...sessionArgs());
          },
        },
        updateInfo: {
          async get(args) {
            if (args._updateStrategy === "appVersion") {
              const channel = args.channel ?? "production";
              const minBundleId = args.minBundleId ?? NIL_UUID;
              const rows = await bundles
                .find(
                  {
                    enabled: true,
                    platform: args.platform,
                    channel,
                    id: { $gte: minBundleId },
                    target_app_version: { $exists: true, $nin: [null, ""] },
                  },
                  ...sessionArgs(),
                )
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
                      .find(
                        {
                          enabled: true,
                          platform: args.platform,
                          channel,
                          id: { $gte: minBundleId },
                          target_app_version: { $in: compatibleAppVersions },
                        },
                        ...sessionArgs(),
                      )
                      .sort({ id: -1 })
                      .toArray()
                  : [];

              return resolveUpdateInfoFromBundles({
                args: { ...args, channel, minBundleId },
                bundles: await mapRowsToBundles(updateRows),
              });
            }

            const channel = args.channel ?? "production";
            const minBundleId = args.minBundleId ?? NIL_UUID;
            const rows = await bundles
              .find(
                {
                  enabled: true,
                  platform: args.platform,
                  channel,
                  id: { $gte: minBundleId },
                  fingerprint_hash: args.fingerprintHash,
                },
                ...sessionArgs(),
              )
              .sort({ id: -1 })
              .toArray();

            return resolveUpdateInfoFromBundles({
              args: { ...args, channel, minBundleId },
              bundles: await mapRowsToBundles(rows),
            });
          },
        },
      };
    };

    const core = createCore();
    if (
      config.transactions !== "enabled" ||
      typeof client.startSession !== "function"
    ) {
      return core;
    }

    return {
      ...core,
      beginTransaction: async () => {
        const session = client.startSession();
        return createCallbackDatabaseTransaction<ClientSession>({
          createCore,
          onSettled: () => session.endSession(),
          run: (operation) => session.withTransaction(() => operation(session)),
        });
      },
    };
  },
});

export const mongoAdapter = (
  config: MongoDBConfig,
): DatabaseAdapterCapabilities & DatabasePluginRuntime => {
  return Object.assign(createMongoPlugin(config), {
    adapterName: "mongodb",
    provider: "mongodb" as const,
    createMigrator: () => createMongoMigrator(config.client),
  });
};
