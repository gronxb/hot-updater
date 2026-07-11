// noqa: SIZE_OK - Existing MongoDB adapter module; splitting belongs to a dedicated adapter cleanup.
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
import { createLegacyDatabasePlugin } from "@hot-updater/plugin-core/internal";

import {
  bundleRecordToRow,
  type BundlePatchRow,
  type BundleRow,
  rowToDatabaseBundleRecord,
  rowToBundle,
} from "../db/bundleRows";
import { createMongoMigrator } from "../db/fixedMigrator";
import type { MongoClientRuntime, MongoSessionRuntime } from "../db/mongoTypes";
import type { DatabaseAdapterRuntime } from "../db/types";
import { createCallbackDatabaseTransaction } from "./transaction";

export interface MongoDBConfig {
  readonly client: MongoClientRuntime;
  /**
   * Enable only for deployments that support MongoDB multi-document
   * transactions, such as replica sets or sharded clusters.
   */
  readonly transactions?: "enabled";
}

const normalizeBundlePatchRow = (row: BundlePatchRow): BundlePatchRow => ({
  ...row,
  order_index: row.order_index ?? 0,
});

const createMongoPlugin = createLegacyDatabasePlugin({
  name: "mongodb",
  connect: (config: MongoDBConfig): DatabasePluginDeclaration => {
    const { client } = config;
    const db = client.db();
    const bundles = db.collection<BundleRow>("bundles");
    const patches = db.collection<BundlePatchRow>("bundle_patches");
    const createConnection = (
      session?: MongoSessionRuntime,
    ): DatabasePluginDeclaration => {
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
          async findRecords() {
            const rows = await bundles.find({}, ...sessionArgs()).toArray();
            return rows.map(rowToDatabaseBundleRecord);
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
        patches: {
          storage: "rows",
          async findRows() {
            const rows = await patches
              .find({}, ...sessionArgs())
              .sort({ order_index: 1 })
              .toArray();
            return rows.map(normalizeBundlePatchRow);
          },
          async getRowById({ patchId }) {
            const row = await patches.findOne(
              { id: patchId },
              ...sessionArgs(),
            );
            return row ? normalizeBundlePatchRow(row) : null;
          },
          async insertRow({ row }) {
            await patches.insertMany([row], ...sessionArgs());
          },
          async updateRow({ patchId, row }) {
            await patches.updateOne(
              { id: patchId },
              { $set: row },
              ...sessionArgs(),
            );
          },
          async deleteRow({ patchId }) {
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

    const connection = createConnection();
    const startSession = client.startSession;
    if (
      config.transactions !== "enabled" ||
      typeof startSession !== "function"
    ) {
      return connection;
    }

    return {
      ...connection,
      beginTransaction: async () => {
        const session = startSession();
        return createCallbackDatabaseTransaction<MongoSessionRuntime>({
          createConnection,
          onSettled: () => Promise.resolve(session.endSession()),
          run: (operation) => session.withTransaction(() => operation(session)),
        });
      },
    };
  },
});

export const mongoAdapter = (config: MongoDBConfig): DatabaseAdapterRuntime => {
  return Object.assign(createMongoPlugin(config), {
    adapterName: "mongodb",
    provider: "mongodb" as const,
    createMigrator: () => createMongoMigrator(config.client),
  });
};
