import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

export interface SupabaseDatabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const supabaseDatabase =
  (config: SupabaseDatabaseConfig, hooks?: DatabasePluginHooks) =>
  (_: BasePluginArgs): DatabasePlugin => {
    const supabase = createClient<Database>(
      config.supabaseUrl,
      config.supabaseAnonKey,
    );

    let bundles: Bundle[] = [];

    const changedIds = new Set<string>();
    function markChanged(id: string) {
      changedIds.add(id);
    }

    return {
      name: "supabaseDatabase",
      async commitBundle() {
        if (changedIds.size === 0) {
          return;
        }
        const changedBundles = bundles.filter((b) => changedIds.has(b.id));
        if (changedBundles.length === 0) {
          return;
        }

        await supabase.from("bundles").upsert(
          changedBundles.map((bundle) => ({
            id: bundle.id,
            app_name: bundle.appName,
            enabled: bundle.enabled,
            file_url: bundle.fileUrl,
            should_force_update: bundle.shouldForceUpdate,
            file_hash: bundle.fileHash,
            git_commit_hash: bundle.gitCommitHash,
            message: bundle.message,
            platform: bundle.platform,
            target_app_version: bundle.targetAppVersion,
          })),
          { onConflict: "id" },
        );

        changedIds.clear();
        hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        bundles = await this.getBundles();

        const targetIndex = bundles.findIndex((u) => u.id === targetBundleId);
        if (targetIndex === -1) {
          throw new Error("target bundle version not found");
        }

        Object.assign(bundles[targetIndex], newBundle);
        markChanged(targetBundleId);
      },
      async appendBundle(inputBundle) {
        bundles = await this.getBundles();
        bundles.unshift(inputBundle);
        markChanged(inputBundle.id);
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
          appName: data.app_name,
          fileUrl: data.file_url,
          shouldForceUpdate: data.should_force_update,
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
          appName: bundle.app_name,
          fileUrl: bundle.file_url,
          shouldForceUpdate: bundle.should_force_update,
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
