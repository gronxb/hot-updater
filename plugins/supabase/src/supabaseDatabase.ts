import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getManifestFileHash,
  getManifestStorageUri,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
  stripBundleArtifactMetadata,
  type SnakeCaseBundle,
} from "@hot-updater/core";
import type { Bundle, Platform } from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import { getUpdateInfo } from "./getUpdateInfo";
import type { Database } from "./types";

export interface SupabaseDatabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

const normalizeMetadata = (value: unknown): Bundle["metadata"] => {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return normalizeMetadata(parsed);
    } catch {
      return {};
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Bundle["metadata"];
  }

  return {};
};

const BUNDLE_SELECT_COLUMNS =
  "id, channel, enabled, platform, should_force_update, file_hash, git_commit_hash, message, fingerprint_hash, target_app_version, storage_uri, metadata, manifest_storage_uri, manifest_file_hash, asset_base_storage_uri, patch_base_bundle_id, patch_base_file_hash, patch_file_hash, patch_storage_uri, rollout_cohort_count, target_cohorts";

const mapRowToBundle = (row: SnakeCaseBundle): Bundle => {
  const rawMetadata = normalizeMetadata(row.metadata);
  return {
    channel: row.channel,
    enabled: Boolean(row.enabled),
    shouldForceUpdate: Boolean(row.should_force_update),
    fileHash: row.file_hash,
    gitCommitHash: row.git_commit_hash,
    id: row.id,
    message: row.message,
    platform: row.platform,
    targetAppVersion: row.target_app_version,
    fingerprintHash: row.fingerprint_hash,
    storageUri: row.storage_uri,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri:
      row.manifest_storage_uri ??
      getManifestStorageUri({ metadata: rawMetadata }),
    manifestFileHash:
      row.manifest_file_hash ?? getManifestFileHash({ metadata: rawMetadata }),
    assetBaseStorageUri:
      row.asset_base_storage_uri ??
      getAssetBaseStorageUri({ metadata: rawMetadata }),
    patchBaseBundleId:
      row.patch_base_bundle_id ??
      getPatchBaseBundleId({ metadata: rawMetadata }),
    patchBaseFileHash:
      row.patch_base_file_hash ??
      getPatchBaseFileHash({ metadata: rawMetadata }),
    patchFileHash:
      row.patch_file_hash ?? getPatchFileHash({ metadata: rawMetadata }),
    patchStorageUri:
      row.patch_storage_uri ?? getPatchStorageUri({ metadata: rawMetadata }),
    rolloutCohortCount:
      row.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: row.target_cohorts ?? null,
  };
};

const bundleToRow = (bundle: Bundle): SnakeCaseBundle => ({
  id: bundle.id,
  channel: bundle.channel,
  enabled: bundle.enabled,
  should_force_update: bundle.shouldForceUpdate,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash,
  message: bundle.message,
  platform: bundle.platform,
  target_app_version: bundle.targetAppVersion,
  fingerprint_hash: bundle.fingerprintHash,
  storage_uri: bundle.storageUri,
  metadata: stripBundleArtifactMetadata(bundle.metadata) ?? {},
  manifest_storage_uri: getManifestStorageUri(bundle),
  manifest_file_hash: getManifestFileHash(bundle),
  asset_base_storage_uri: getAssetBaseStorageUri(bundle),
  patch_base_bundle_id: getPatchBaseBundleId(bundle),
  patch_base_file_hash: getPatchBaseFileHash(bundle),
  patch_file_hash: getPatchFileHash(bundle),
  patch_storage_uri: getPatchStorageUri(bundle),
  rollout_cohort_count:
    bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  target_cohorts: bundle.targetCohorts ?? null,
});

export const supabaseDatabase = createDatabasePlugin<SupabaseDatabaseConfig>({
  name: "supabaseDatabase",
  factory: (config) => {
    const supabase = createClient<Database>(
      config.supabaseUrl,
      config.supabaseAnonKey,
    );

    return {
      async getUpdateInfo(args) {
        return getUpdateInfo(supabase, args);
      },

      async getBundleById(bundleId) {
        const { data, error } = await supabase
          .from("bundles")
          .select(BUNDLE_SELECT_COLUMNS)
          .eq("id", bundleId)
          .single();

        if (!data || error) {
          return null;
        }
        return mapRowToBundle(data);
      },

      async getBundles(options) {
        const { where, limit, orderBy } = options ?? {};
        const offset =
          ((options && "offset" in options ? options.offset : undefined) as
            | number
            | undefined) ?? 0;

        if (
          (where?.targetAppVersionIn &&
            where.targetAppVersionIn.length === 0) ||
          (where?.id?.in && where.id.in.length === 0)
        ) {
          return {
            data: [],
            pagination: calculatePagination(0, { limit, offset }),
          };
        }

        let countQuery = supabase
          .from("bundles")
          .select("*", { count: "exact", head: true });

        if (where?.channel) {
          countQuery = countQuery.eq("channel", where.channel);
        }
        if (where?.platform) {
          countQuery = countQuery.eq("platform", where.platform as Platform);
        }
        if (where?.enabled !== undefined) {
          countQuery = countQuery.eq("enabled", where.enabled);
        }
        if (where?.fingerprintHash !== undefined) {
          countQuery =
            where.fingerprintHash === null
              ? countQuery.is("fingerprint_hash", null)
              : countQuery.eq("fingerprint_hash", where.fingerprintHash);
        }
        if (where?.targetAppVersion !== undefined) {
          countQuery =
            where.targetAppVersion === null
              ? countQuery.is("target_app_version", null)
              : countQuery.eq("target_app_version", where.targetAppVersion);
        }
        if (where?.targetAppVersionIn) {
          countQuery = countQuery.in(
            "target_app_version",
            where.targetAppVersionIn,
          );
        }
        if (where?.targetAppVersionNotNull) {
          countQuery = countQuery.not("target_app_version", "is", null);
        }
        if (where?.id?.eq) {
          countQuery = countQuery.eq("id", where.id.eq);
        }
        if (where?.id?.gt) {
          countQuery = countQuery.gt("id", where.id.gt);
        }
        if (where?.id?.gte) {
          countQuery = countQuery.gte("id", where.id.gte);
        }
        if (where?.id?.lt) {
          countQuery = countQuery.lt("id", where.id.lt);
        }
        if (where?.id?.lte) {
          countQuery = countQuery.lte("id", where.id.lte);
        }
        if (where?.id?.in) {
          countQuery = countQuery.in("id", where.id.in);
        }

        const { count: total = 0 } = await countQuery;

        let query = supabase
          .from("bundles")
          .select(BUNDLE_SELECT_COLUMNS)
          .order("id", { ascending: orderBy?.direction === "asc" });

        if (where?.channel) {
          query = query.eq("channel", where.channel);
        }

        if (where?.platform) {
          query = query.eq("platform", where.platform as Platform);
        }
        if (where?.enabled !== undefined) {
          query = query.eq("enabled", where.enabled);
        }
        if (where?.fingerprintHash !== undefined) {
          query =
            where.fingerprintHash === null
              ? query.is("fingerprint_hash", null)
              : query.eq("fingerprint_hash", where.fingerprintHash);
        }
        if (where?.targetAppVersion !== undefined) {
          query =
            where.targetAppVersion === null
              ? query.is("target_app_version", null)
              : query.eq("target_app_version", where.targetAppVersion);
        }
        if (where?.targetAppVersionIn) {
          query = query.in("target_app_version", where.targetAppVersionIn);
        }
        if (where?.targetAppVersionNotNull) {
          query = query.not("target_app_version", "is", null);
        }
        if (where?.id?.eq) {
          query = query.eq("id", where.id.eq);
        }
        if (where?.id?.gt) {
          query = query.gt("id", where.id.gt);
        }
        if (where?.id?.gte) {
          query = query.gte("id", where.id.gte);
        }
        if (where?.id?.lt) {
          query = query.lt("id", where.id.lt);
        }
        if (where?.id?.lte) {
          query = query.lte("id", where.id.lte);
        }
        if (where?.id?.in) {
          query = query.in("id", where.id.in);
        }

        if (limit) {
          query = query.limit(limit);
        }

        if (offset) {
          query = query.range(offset, offset + (limit || 20) - 1);
        }

        const { data } = await query;

        const bundles = data ? data.map(mapRowToBundle) : [];

        const pagination = calculatePagination(total ?? 0, { limit, offset });

        return {
          data: bundles,
          pagination,
        };
      },

      async getChannels() {
        const { data, error } = await supabase.rpc("get_channels");
        if (error) {
          throw error;
        }
        return data.map((bundle: { channel: string }) => bundle.channel);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        // Process each operation sequentially
        for (const op of changedSets) {
          if (op.operation === "delete") {
            // Handle delete operation
            const { error } = await supabase
              .from("bundles")
              .delete()
              .eq("id", op.data.id);

            if (error) {
              throw new Error(`Failed to delete bundle: ${error.message}`);
            }
          } else if (op.operation === "insert" || op.operation === "update") {
            // Handle insert and update operations
            const bundle = op.data;
            const { error } = await supabase
              .from("bundles")
              .upsert(bundleToRow(bundle), { onConflict: "id" });

            if (error) {
              throw error;
            }
          }
        }
      },
    };
  },
});
