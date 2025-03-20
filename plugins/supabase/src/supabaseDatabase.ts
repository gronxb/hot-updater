import type { Bundle, DatabasePluginHooks } from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export interface SupabaseDatabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const supabaseDatabase = (
  config: SupabaseDatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    config.supabaseAnonKey,
  );

  return createDatabasePlugin(
    "supabaseDatabase",
    {
      async getBundleById(bundleId) {
        const { data, error } = await supabase
          .from("bundles")
          .select("*")
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
        } as Bundle;
      },

      async getBundles(options) {
        const { where, limit, offset = 0 } = options ?? {};
        let query = supabase
          .from("bundles")
          .select("*")
          .order("id", { ascending: false });

        if (where?.channel) {
          query = query.eq("channel", where.channel);
        }

        if (where?.platform) {
          query = query.eq("platform", where.platform);
        }

        if (limit) {
          query = query.limit(limit);
        }

        if (offset) {
          query = query.range(offset, offset + (limit || 20) - 1);
        }

        const { data } = await query;

        if (!data) {
          return [];
        }

        return data.map((bundle) => ({
          channel: bundle.channel,
          enabled: bundle.enabled,
          shouldForceUpdate: bundle.should_force_update,
          fileHash: bundle.file_hash,
          gitCommitHash: bundle.git_commit_hash,
          id: bundle.id,
          message: bundle.message,
          platform: bundle.platform,
          targetAppVersion: bundle.target_app_version,
        })) as Bundle[];
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

        const bundles = changedSets.map((op) => op.data);

        const { error } = await supabase.from("bundles").upsert(
          bundles.map((bundle) => ({
            id: bundle.id,
            channel: bundle.channel,
            enabled: bundle.enabled,
            should_force_update: bundle.shouldForceUpdate,
            file_hash: bundle.fileHash,
            git_commit_hash: bundle.gitCommitHash,
            message: bundle.message,
            platform: bundle.platform,
            target_app_version: bundle.targetAppVersion,
          })),
          { onConflict: "id" },
        );

        if (error) {
          throw error;
        }
      },
    },
    hooks,
  );
};
