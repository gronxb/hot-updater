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
            "channel, enabled, should_force_update, file_hash, git_commit_hash, id, message, platform, target_app_version, fingerprint_hash, storage_uri, metadata",
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
        } as Bundle;
      },

      async getBundles(options) {
        const { where, limit, offset } = options ?? {};

        let countQuery = supabase
          .from("bundles")
          .select("*", { count: "exact", head: true });

        if (where?.channel) {
          countQuery = countQuery.eq("channel", where.channel);
        }
        if (where?.platform) {
          countQuery = countQuery.eq("platform", where.platform as Platform);
        }

        const { count: total = 0 } = await countQuery;

        let query = supabase
          .from("bundles")
          .select(
            "id, channel, enabled, platform, should_force_update, file_hash, git_commit_hash, message, fingerprint_hash, target_app_version, storage_uri, metadata",
          )
          .order("id", { ascending: false });

        if (where?.channel) {
          query = query.eq("channel", where.channel);
        }

        if (where?.platform) {
          query = query.eq("platform", where.platform as Platform);
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
