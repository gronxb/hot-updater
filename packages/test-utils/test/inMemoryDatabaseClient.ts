import type { Bundle } from "@hot-updater/core";
import type {
  BundlePatchRow,
  BundleRow,
  DatabasePlugin,
} from "@hot-updater/plugin-core";

import type { DatabaseClientTestContract } from "../src/setupDatabaseClientTestSuite";

const toBundleRow = (bundle: Bundle): BundleRow => ({
  id: bundle.id,
  platform: bundle.platform,
  should_force_update: bundle.shouldForceUpdate,
  enabled: bundle.enabled,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash,
  message: bundle.message,
  channel: bundle.channel,
  storage_uri: bundle.storageUri,
  target_app_version: bundle.targetAppVersion,
  fingerprint_hash: bundle.fingerprintHash,
  metadata: bundle.metadata ?? {},
  rollout_cohort_count: bundle.rolloutCohortCount ?? 1000,
  target_cohorts: bundle.targetCohorts ?? null,
  manifest_storage_uri: bundle.manifestStorageUri ?? null,
  manifest_file_hash: bundle.manifestFileHash ?? null,
  asset_base_storage_uri: bundle.assetBaseStorageUri ?? null,
});

const toPatchRows = (bundle: Bundle): BundlePatchRow[] =>
  (bundle.patches ?? []).map((patch, orderIndex) => ({
    id: `${bundle.id}:${patch.baseBundleId}`,
    bundle_id: bundle.id,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: orderIndex,
  }));

const toBundle = (
  row: BundleRow,
  patchRows: readonly BundlePatchRow[],
): Bundle => ({
  id: row.id,
  platform: row.platform,
  shouldForceUpdate: row.should_force_update,
  enabled: row.enabled,
  fileHash: row.file_hash,
  gitCommitHash: row.git_commit_hash,
  message: row.message,
  channel: row.channel,
  storageUri: row.storage_uri,
  targetAppVersion: row.target_app_version,
  fingerprintHash: row.fingerprint_hash,
  rolloutCohortCount: row.rollout_cohort_count,
  targetCohorts: row.target_cohorts === null ? null : [...row.target_cohorts],
  manifestStorageUri: row.manifest_storage_uri,
  manifestFileHash: row.manifest_file_hash,
  assetBaseStorageUri: row.asset_base_storage_uri,
  patches: patchRows
    .toSorted(
      (left, right) =>
        left.order_index - right.order_index || left.id.localeCompare(right.id),
    )
    .map((patch) => ({
      baseBundleId: patch.base_bundle_id,
      baseFileHash: patch.base_file_hash,
      patchFileHash: patch.patch_file_hash,
      patchStorageUri: patch.patch_storage_uri,
    })),
});

export const createInMemoryDatabaseClient = (
  adapter: DatabasePlugin,
): DatabaseClientTestContract<unknown> => {
  const getBundleById = async (id: string): Promise<Bundle | null> => {
    const row = await adapter.findOne({
      model: "bundles",
      where: [{ field: "id", value: id }],
    });
    if (row === null) return null;
    const patches = await adapter.findMany({
      model: "bundle_patches",
      where: [{ field: "bundle_id", value: id }],
      sortBy: { field: "order_index", direction: "asc" },
    });
    return toBundle(row, patches);
  };

  const insertBundle = async (bundle: Bundle): Promise<void> => {
    const channel = await adapter.findOne({
      model: "channels",
      where: [{ field: "id", value: bundle.channel }],
    });
    if (channel === null) {
      await adapter.create({
        model: "channels",
        data: { id: bundle.channel },
      });
    }
    await adapter.create({ model: "bundles", data: toBundleRow(bundle) });
    for (const patch of toPatchRows(bundle)) {
      await adapter.create({ model: "bundle_patches", data: patch });
    }
  };

  return {
    getBundleById,
    getBundles: async (options) => {
      const rows = await adapter.findMany({
        model: "bundles",
        limit: options.limit,
        sortBy: options.orderBy,
      });
      const data: Bundle[] = [];
      for (const row of rows) {
        const bundle = await getBundleById(row.id);
        if (bundle !== null) data.push(bundle);
      }
      const total = await adapter.count({ model: "bundles" });
      return {
        data,
        pagination: {
          total,
          hasNextPage: data.length < total,
          hasPreviousPage: false,
          currentPage: 1,
          totalPages: total === 0 ? 0 : Math.ceil(total / options.limit),
        },
      };
    },
    getChannels: async () =>
      (
        await adapter.findMany({
          model: "channels",
          sortBy: { field: "id", direction: "asc" },
        })
      ).map(({ id }) => id),
    insertBundle,
    updateBundleById: async (id, update) => {
      const current = await getBundleById(id);
      if (current === null) return;
      const next = { ...current, ...update };
      const { id: ignoredId, ...rowUpdate } = toBundleRow(next);
      void ignoredId;
      await adapter.update({
        model: "bundles",
        where: [{ field: "id", value: id }],
        update: rowUpdate,
      });
      if (update.patches !== undefined) {
        await adapter.delete({
          model: "bundle_patches",
          where: [{ field: "bundle_id", value: id }],
        });
        for (const patch of toPatchRows(next)) {
          await adapter.create({ model: "bundle_patches", data: patch });
        }
      }
    },
    deleteBundleById: async (id) => {
      await adapter.delete({
        model: "bundle_patches",
        where: [
          { field: "bundle_id", value: id },
          { field: "base_bundle_id", value: id, connector: "OR" },
        ],
      });
      await adapter.delete({
        model: "bundles",
        where: [{ field: "id", value: id }],
      });
    },
  };
};
