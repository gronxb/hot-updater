import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const supabase =
  (config: SupabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const supabase = createClient<Database>(
      config.supabaseUrl,
      config.supabaseAnonKey,
    );

    let bundles: Bundle[] = [];

    return {
      name: "supabase",
      async commitBundle() {
        await supabase.from("bundles").upsert(
          bundles.map((bundle) => ({
            id: bundle.id,
            enabled: bundle.enabled,
            file_url: bundle.fileUrl,
            force_update: bundle.forceUpdate,
            file_hash: bundle.fileHash,
            git_commit_hash: bundle.gitCommitHash,
            message: bundle.message,
            platform: bundle.platform,
            target_app_version: bundle.targetAppVersion,
          })),
          { onConflict: "id" },
        );

        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        bundles = await this.getBundles();

        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(bundles[targetIndex], newBundle);
      },
      async appendBundle(inputBundle) {
        bundles = await this.getBundles();
        bundles.unshift(inputBundle);
      },
      async setBundles(inputBundles) {
        bundles = inputBundles;
      },
      async getBundleById(bundleId) {
        const { data } = await supabase
          .from("bundles")
          .select("*")
          .eq("id", bundleId)
          .single();

        if (!data) {
          return null;
        }
        return {
          enabled: data.enabled,
          fileUrl: data.file_url,
          forceUpdate: data.force_update,
          fileHash: data.file_hash,
          gitCommitHash: data.git_commit_hash,
          id: data.id,
          message: data.message,
          platform: data.platform,
          targetAppVersion: data.target_app_version,
        } as Bundle;
      },
      async getBundles(refresh = false) {
        if (bundles.length > 0 && !refresh) {
          return bundles;
        }

        const { data } = await supabase
          .from("bundles")
          .select("*")
          .order("id", { ascending: false });

        if (!data) {
          return [];
        }

        return data.map((bundle) => ({
          enabled: bundle.enabled,
          fileUrl: bundle.file_url,
          forceUpdate: bundle.force_update,
          fileHash: bundle.file_hash,
          gitCommitHash: bundle.git_commit_hash,
          id: bundle.id,
          message: bundle.message,
          platform: bundle.platform,
          targetAppVersion: bundle.target_app_version,
        })) as Bundle[];
      },
    };
  };
