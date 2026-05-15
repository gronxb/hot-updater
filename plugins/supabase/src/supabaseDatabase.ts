import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
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
  createDatabasePluginGetUpdateInfo,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import type { SupabaseBundlePatchRow, SupabaseBundleRow } from "./types";

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
  "id, channel, enabled, platform, should_force_update, file_hash, git_commit_hash, message, fingerprint_hash, target_app_version, storage_uri, metadata, manifest_storage_uri, manifest_file_hash, asset_base_storage_uri, rollout_cohort_count, target_cohorts";

const createSupabaseError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }

  if (error && typeof error === "object") {
    const properties: Record<string, unknown> = {};
    let target: object | null = error;
    while (target && target !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(target)) {
        properties[key] = (error as Record<string, unknown>)[key];
      }
      target = Object.getPrototypeOf(target);
    }

    return new Error(
      JSON.stringify({
        name: error.constructor.name,
        ...properties,
      }),
    );
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
};

const buildBundlePatchId = (bundleId: string, baseBundleId: string) =>
  `${bundleId}:${baseBundleId}`;

const mapRowToBundle = (
  row: SupabaseBundleRow,
  patchRows: SupabaseBundlePatchRow[] = [],
): Bundle => {
  const rawMetadata = normalizeMetadata(row.metadata);
  const patches = patchRows
    .slice()
    .sort(
      (left, right) =>
        left.order_index - right.order_index ||
        left.base_bundle_id.localeCompare(right.base_bundle_id),
    )
    .map((patch) => ({
      baseBundleId: patch.base_bundle_id,
      baseFileHash: patch.base_file_hash,
      patchFileHash: patch.patch_file_hash,
      patchStorageUri: patch.patch_storage_uri,
    }));
  const primaryPatch = patches[0] ?? null;

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
    manifestStorageUri: row.manifest_storage_uri ?? null,
    manifestFileHash: row.manifest_file_hash ?? null,
    assetBaseStorageUri: row.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
    rolloutCohortCount:
      row.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: row.target_cohorts ?? null,
  };
};

const bundleToRow = (bundle: Bundle): SupabaseBundleRow => ({
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
  rollout_cohort_count:
    bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  target_cohorts: bundle.targetCohorts ?? null,
});

const bundleToPatchRows = (bundle: Bundle): SupabaseBundlePatchRow[] =>
  getBundlePatches(bundle).map((patch, index) => ({
    id: buildBundlePatchId(bundle.id, patch.baseBundleId),
    bundle_id: bundle.id,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: index,
  }));

export const supabaseDatabase = createDatabasePlugin<SupabaseDatabaseConfig>({
  name: "supabaseDatabase",
  factory: (config) => {
    const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
    const fetchPatchMap = async (bundleIds: string[]) => {
      const patchMap = new Map<string, SupabaseBundlePatchRow[]>();

      if (bundleIds.length === 0) {
        return patchMap;
      }

      const { data, error } = await supabase
        .from("bundle_patches")
        .select("*")
        .in("bundle_id", bundleIds)
        .order("order_index", { ascending: true });

      if (error) {
        throw createSupabaseError(error);
      }

      for (const row of data ?? []) {
        const current = patchMap.get(row.bundle_id) ?? [];
        current.push(row);
        patchMap.set(row.bundle_id, current);
      }

      return patchMap;
    };
    const mapRowsToBundles = async (rows: SupabaseBundleRow[]) => {
      const patchMap = await fetchPatchMap(rows.map((row) => row.id));
      return rows.map((row) => mapRowToBundle(row, patchMap.get(row.id)));
    };

    return {
      getUpdateInfo: createDatabasePluginGetUpdateInfo({
        async listTargetAppVersions({ platform, channel, minBundleId }) {
          const { data, error } = await supabase
            .from("bundles")
            .select("target_app_version")
            .eq("platform", platform)
            .eq("channel", channel)
            .eq("enabled", true)
            .gte("id", minBundleId)
            .not("target_app_version", "is", null);

          if (error) {
            throw createSupabaseError(error);
          }

          return Array.from(
            new Set(
              (data ?? [])
                .map((row) => row.target_app_version)
                .filter((version): version is string => Boolean(version)),
            ),
          );
        },
        async getBundlesByTargetAppVersions(
          { platform, channel, minBundleId },
          targetAppVersions,
        ) {
          const { data, error } = await supabase
            .from("bundles")
            .select(BUNDLE_SELECT_COLUMNS)
            .eq("platform", platform)
            .eq("channel", channel)
            .eq("enabled", true)
            .gte("id", minBundleId)
            .in("target_app_version", targetAppVersions);

          if (error) {
            throw createSupabaseError(error);
          }

          return mapRowsToBundles(data ?? []);
        },
        async getBundlesByFingerprint({
          platform,
          channel,
          minBundleId,
          fingerprintHash,
        }) {
          const { data, error } = await supabase
            .from("bundles")
            .select(BUNDLE_SELECT_COLUMNS)
            .eq("platform", platform)
            .eq("channel", channel)
            .eq("enabled", true)
            .gte("id", minBundleId)
            .eq("fingerprint_hash", fingerprintHash);

          if (error) {
            throw createSupabaseError(error);
          }

          return mapRowsToBundles(data ?? []);
        },
      }),

      async getBundleById(bundleId) {
        const [{ data, error }, patchMap] = await Promise.all([
          supabase
            .from("bundles")
            .select(BUNDLE_SELECT_COLUMNS)
            .eq("id", bundleId)
            .single(),
          fetchPatchMap([bundleId]),
        ]);

        if (!data || error) {
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

        const patchMap = await fetchPatchMap(
          (data ?? []).map((bundle) => bundle.id),
        );
        const bundles = (data ?? []).map((bundle) =>
          mapRowToBundle(bundle, patchMap.get(bundle.id) ?? []),
        );

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
            const { error: patchDeleteError } = await supabase
              .from("bundle_patches")
              .delete()
              .eq("bundle_id", op.data.id);

            if (patchDeleteError) {
              throw new Error(
                `Failed to delete bundle patches: ${patchDeleteError.message}`,
              );
            }

            const { error: basePatchDeleteError } = await supabase
              .from("bundle_patches")
              .delete()
              .eq("base_bundle_id", op.data.id);

            if (basePatchDeleteError) {
              throw new Error(
                `Failed to delete base bundle patches: ${basePatchDeleteError.message}`,
              );
            }

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
            const patchRows = bundleToPatchRows(bundle);
            const { error } = await supabase
              .from("bundles")
              .upsert(bundleToRow(bundle), { onConflict: "id" });

            if (error) {
              throw error;
            }

            const { error: patchDeleteError } = await supabase
              .from("bundle_patches")
              .delete()
              .eq("bundle_id", bundle.id);

            if (patchDeleteError) {
              throw patchDeleteError;
            }

            if (patchRows.length > 0) {
              const { error: patchInsertError } = await supabase
                .from("bundle_patches")
                .upsert(patchRows, { onConflict: "id" });

              if (patchInsertError) {
                throw patchInsertError;
              }
            }
          }
        }
      },
    };
  },
});
