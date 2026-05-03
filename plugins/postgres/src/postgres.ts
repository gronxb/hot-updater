import {
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";
import type { Bundle, Platform } from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";

import { getUpdateInfo } from "./getUpdateInfo";
import type {
  Database,
  PostgresBundlePatchRow,
  PostgresBundleRow,
} from "./types";

export interface PostgresConfig extends PoolConfig {}

const normalizeMetadata = (value: unknown): Bundle["metadata"] => {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      return normalizeMetadata(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Bundle["metadata"];
  }

  return undefined;
};

const buildBundlePatchId = (bundleId: string, baseBundleId: string) =>
  `${bundleId}:${baseBundleId}`;

const mapPatchRowToPatch = (row: PostgresBundlePatchRow) => ({
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
});

const mapRowToBundle = (
  data: PostgresBundleRow,
  patchRows: PostgresBundlePatchRow[] = [],
): Bundle => {
  const rawMetadata = normalizeMetadata(data.metadata);
  const patches = patchRows
    .slice()
    .sort(
      (left, right) =>
        left.order_index - right.order_index ||
        left.base_bundle_id.localeCompare(right.base_bundle_id),
    )
    .map(mapPatchRowToPatch);
  const primaryPatch = patches[0] ?? null;

  return {
    enabled: data.enabled,
    shouldForceUpdate: data.should_force_update,
    fileHash: data.file_hash,
    gitCommitHash: data.git_commit_hash,
    id: data.id,
    message: data.message,
    platform: data.platform,
    targetAppVersion: data.target_app_version,
    channel: data.channel,
    storageUri: data.storage_uri,
    fingerprintHash: data.fingerprint_hash,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri:
      data.manifest_storage_uri ??
      getManifestStorageUri({ metadata: rawMetadata }),
    manifestFileHash:
      data.manifest_file_hash ?? getManifestFileHash({ metadata: rawMetadata }),
    assetBaseStorageUri:
      data.asset_base_storage_uri ??
      getAssetBaseStorageUri({ metadata: rawMetadata }),
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
    rolloutCohortCount: data.rollout_cohort_count,
    targetCohorts: data.target_cohorts,
  };
};

const bundleToRowValues = (bundle: Bundle): Database["bundles"] => ({
  id: bundle.id,
  enabled: bundle.enabled,
  should_force_update: bundle.shouldForceUpdate,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash,
  message: bundle.message,
  platform: bundle.platform,
  target_app_version: bundle.targetAppVersion,
  channel: bundle.channel,
  storage_uri: bundle.storageUri,
  fingerprint_hash: bundle.fingerprintHash,
  metadata: stripBundleArtifactMetadata(bundle.metadata) ?? {},
  manifest_storage_uri: getManifestStorageUri(bundle),
  manifest_file_hash: getManifestFileHash(bundle),
  asset_base_storage_uri: getAssetBaseStorageUri(bundle),
  rollout_cohort_count: bundle.rolloutCohortCount ?? null,
  target_cohorts: bundle.targetCohorts ?? null,
});

const bundleToPatchRows = (bundle: Bundle): Database["bundle_patches"][] =>
  getBundlePatches(bundle).map((patch, index) => ({
    id: buildBundlePatchId(bundle.id, patch.baseBundleId),
    bundle_id: bundle.id,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: index,
  }));

export const postgres = createDatabasePlugin<PostgresConfig>({
  name: "postgres",
  factory: (config) => {
    const pool = new Pool(config);
    const dialect = new PostgresDialect({ pool });
    const db = new Kysely<Database>({ dialect });
    const fetchPatchMap = async (bundleIds: string[]) => {
      const patchMap = new Map<string, PostgresBundlePatchRow[]>();

      if (bundleIds.length === 0) {
        return patchMap;
      }

      const rows = await db
        .selectFrom("bundle_patches")
        .selectAll()
        .where("bundle_id", "in", bundleIds)
        .orderBy("order_index", "asc")
        .execute();

      for (const row of rows) {
        const current = patchMap.get(row.bundle_id) ?? [];
        current.push(row);
        patchMap.set(row.bundle_id, current);
      }

      return patchMap;
    };

    return {
      async onUnmount() {
        await db.destroy();
        await pool.end();
      },
      async getUpdateInfo(args) {
        return getUpdateInfo(pool, args);
      },
      async getBundleById(bundleId) {
        const [data, patchMap] = await Promise.all([
          db
            .selectFrom("bundles")
            .selectAll()
            .where("id", "=", bundleId)
            .executeTakeFirst(),
          fetchPatchMap([bundleId]),
        ]);

        if (!data) {
          return null;
        }
        return mapRowToBundle(data, patchMap.get(bundleId) ?? []);
      },

      async getBundles(options) {
        const { where, limit, orderBy } = options ?? {};
        const offset =
          ((options && "offset" in options ? options.offset : undefined) as
            | number
            | undefined) ?? 0;

        let countQuery = db.selectFrom("bundles");
        if (where?.channel) {
          countQuery = countQuery.where("channel", "=", where.channel);
        }
        if (where?.platform) {
          countQuery = countQuery.where(
            "platform",
            "=",
            where.platform as Platform,
          );
        }
        if (where?.enabled !== undefined) {
          countQuery = countQuery.where("enabled", "=", where.enabled);
        }
        if (where?.fingerprintHash !== undefined) {
          countQuery =
            where.fingerprintHash === null
              ? countQuery.where("fingerprint_hash", "is", null)
              : countQuery.where(
                  "fingerprint_hash",
                  "=",
                  where.fingerprintHash,
                );
        }
        if (where?.targetAppVersion !== undefined) {
          countQuery =
            where.targetAppVersion === null
              ? countQuery.where("target_app_version", "is", null)
              : countQuery.where(
                  "target_app_version",
                  "=",
                  where.targetAppVersion,
                );
        }
        if (where?.targetAppVersionIn) {
          countQuery = countQuery.where(
            "target_app_version",
            "in",
            where.targetAppVersionIn,
          );
        }
        if (where?.targetAppVersionNotNull) {
          countQuery = countQuery.where("target_app_version", "is not", null);
        }
        if (where?.id?.eq) {
          countQuery = countQuery.where("id", "=", where.id.eq);
        }
        if (where?.id?.gt) {
          countQuery = countQuery.where("id", ">", where.id.gt);
        }
        if (where?.id?.gte) {
          countQuery = countQuery.where("id", ">=", where.id.gte);
        }
        if (where?.id?.lt) {
          countQuery = countQuery.where("id", "<", where.id.lt);
        }
        if (where?.id?.lte) {
          countQuery = countQuery.where("id", "<=", where.id.lte);
        }
        if (where?.id?.in) {
          countQuery = countQuery.where("id", "in", where.id.in);
        }

        const countResult = await countQuery
          .select(db.fn.count<number>("id").as("total"))
          .executeTakeFirst();
        const total = countResult?.total || 0;

        let query = db
          .selectFrom("bundles")
          .orderBy("id", orderBy?.direction === "asc" ? "asc" : "desc");
        if (where?.channel) {
          query = query.where("channel", "=", where.channel);
        }

        if (where?.platform) {
          query = query.where("platform", "=", where.platform as Platform);
        }
        if (where?.enabled !== undefined) {
          query = query.where("enabled", "=", where.enabled);
        }
        if (where?.fingerprintHash !== undefined) {
          query =
            where.fingerprintHash === null
              ? query.where("fingerprint_hash", "is", null)
              : query.where("fingerprint_hash", "=", where.fingerprintHash);
        }
        if (where?.targetAppVersion !== undefined) {
          query =
            where.targetAppVersion === null
              ? query.where("target_app_version", "is", null)
              : query.where("target_app_version", "=", where.targetAppVersion);
        }
        if (where?.targetAppVersionIn) {
          query = query.where(
            "target_app_version",
            "in",
            where.targetAppVersionIn,
          );
        }
        if (where?.targetAppVersionNotNull) {
          query = query.where("target_app_version", "is not", null);
        }
        if (where?.id?.eq) {
          query = query.where("id", "=", where.id.eq);
        }
        if (where?.id?.gt) {
          query = query.where("id", ">", where.id.gt);
        }
        if (where?.id?.gte) {
          query = query.where("id", ">=", where.id.gte);
        }
        if (where?.id?.lt) {
          query = query.where("id", "<", where.id.lt);
        }
        if (where?.id?.lte) {
          query = query.where("id", "<=", where.id.lte);
        }
        if (where?.id?.in) {
          query = query.where("id", "in", where.id.in);
        }

        if (limit) {
          query = query.limit(limit);
        }

        if (offset) {
          query = query.offset(offset);
        }

        const data = await query.selectAll().execute();

        const patchMap = await fetchPatchMap(data.map((bundle) => bundle.id));
        const bundles = data.map((bundle) =>
          mapRowToBundle(bundle, patchMap.get(bundle.id) ?? []),
        );

        const pagination = calculatePagination(total, { limit, offset });

        return {
          data: bundles,
          pagination,
        };
      },

      async getChannels() {
        const data = await db
          .selectFrom("bundles")
          .select("channel")
          .groupBy("channel")
          .execute();
        return data.map((bundle) => bundle.channel);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        await db.transaction().execute(async (tx) => {
          // Process each operation sequentially
          for (const op of changedSets) {
            if (op.operation === "delete") {
              // Handle delete operation
              await tx
                .deleteFrom("bundle_patches")
                .where("bundle_id", "=", op.data.id)
                .execute();
              await tx
                .deleteFrom("bundle_patches")
                .where("base_bundle_id", "=", op.data.id)
                .execute();
              const result = await tx
                .deleteFrom("bundles")
                .where("id", "=", op.data.id)
                .executeTakeFirst();

              // Verify deletion was successful
              if (result.numDeletedRows === 0n) {
                throw new Error(`Bundle with id ${op.data.id} not found`);
              }
            } else if (op.operation === "insert" || op.operation === "update") {
              // Handle insert and update operations
              const bundle = op.data;
              const values = bundleToRowValues(bundle);
              const patchRows = bundleToPatchRows(bundle);
              const { id: _id, ...updateValues } = values;
              await tx
                .insertInto("bundles")
                .values(values)
                .onConflict((oc) => oc.column("id").doUpdateSet(updateValues))
                .execute();
              await tx
                .deleteFrom("bundle_patches")
                .where("bundle_id", "=", bundle.id)
                .execute();
              if (patchRows.length > 0) {
                await tx
                  .insertInto("bundle_patches")
                  .values(patchRows)
                  .execute();
              }
            }
          }
        });
      },
    };
  },
});
