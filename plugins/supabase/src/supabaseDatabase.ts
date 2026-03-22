import { DEFAULT_ROLLOUT_COHORT_COUNT } from "@hot-updater/core";
import type { Bundle, Platform } from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export interface SupabaseDatabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const supabaseDatabase = createDatabasePlugin<SupabaseDatabaseConfig>({
  name: "supabaseDatabase",
  factory: (config) => {
    const supabase = createClient<Database>(
      config.supabaseUrl,
      config.supabaseAnonKey,
    );

    return {
      async getBundleById(bundleId) {
        const { data, error } = await supabase
          .from("bundles")
          .select(
            "channel, enabled, should_force_update, file_hash, git_commit_hash, id, message, platform, target_app_version, fingerprint_hash, storage_uri, metadata, rollout_cohort_count, target_cohorts",
          )
          .eq("id", bundleId)
          .single();

        if (!data || error) {
          return null;
        }
        return {
          channel: data.channel,
          enabled: data.enabled,
          shouldForceUpdate: data.should_force_update,
          fileHash: data.file_hash,
          gitCommitHash: data.git_commit_hash,
          id: data.id,
          message: data.message,
          platform: data.platform,
          targetAppVersion: data.target_app_version,
          fingerprintHash: data.fingerprint_hash,
          storageUri: data.storage_uri,
          metadata: data.metadata ?? {},
          rolloutCohortCount:
            data.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
          targetCohorts: data.target_cohorts ?? null,
        } as Bundle;
      },

      async getBundles(options) {
        const { where, limit, offset, orderBy } = options ?? {};

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
          .select(
            "id, channel, enabled, platform, should_force_update, file_hash, git_commit_hash, message, fingerprint_hash, target_app_version, storage_uri, metadata, rollout_cohort_count, target_cohorts",
          )
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

        const bundles = data
          ? data.map((bundle) => ({
              channel: bundle.channel,
              enabled: bundle.enabled,
              shouldForceUpdate: bundle.should_force_update,
              fileHash: bundle.file_hash,
              gitCommitHash: bundle.git_commit_hash,
              id: bundle.id,
              message: bundle.message,
              platform: bundle.platform,
              targetAppVersion: bundle.target_app_version,
              fingerprintHash: bundle.fingerprint_hash,
              storageUri: bundle.storage_uri,
              metadata: bundle.metadata ?? {},
              rolloutCohortCount:
                bundle.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
              targetCohorts: bundle.target_cohorts ?? null,
            }))
          : [];

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
            const { error } = await supabase.from("bundles").upsert(
              {
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
                metadata: bundle.metadata,
                rollout_cohort_count:
                  bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
                target_cohorts: bundle.targetCohorts ?? null,
              },
              { onConflict: "id" },
            );

            if (error) {
              throw error;
            }
          }
        }
      },
    };
  },
});
