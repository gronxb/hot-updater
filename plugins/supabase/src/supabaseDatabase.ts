import type {
  Bundle,
  DatabasePluginHooks,
  NativeBuild,
} from "@hot-updater/plugin-core";
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

export const supabaseDatabase = (
  config: SupabaseDatabaseConfig,
  hooks?: DatabasePluginHooks,
) =>
  createDatabasePlugin(
    "supabaseDatabase",
    {
      getContext: () => ({
        supabase: createClient<Database>(
          config.supabaseUrl,
          config.supabaseAnonKey,
        ),
      }),
      async getBundleById(context, bundleId) {
        const { data, error } = await context.supabase
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
          fingerprintHash: data.fingerprint_hash,
          storageUri: data.storage_uri,
          metadata: data.metadata ?? {},
        } as Bundle;
      },

      async getBundles(context, options) {
        const { where, limit, offset } = options ?? {};

        let countQuery = context.supabase
          .from("bundles")
          .select("*", { count: "exact", head: true });

        if (where?.channel) {
          countQuery = countQuery.eq("channel", where.channel);
        }
        if (where?.platform) {
          countQuery = countQuery.eq("platform", where.platform);
        }

        const { count: total = 0 } = await countQuery;

        let query = context.supabase
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

      async getChannels(context) {
        const { data, error } = await context.supabase.rpc("get_channels");
        if (error) {
          throw error;
        }
        return data.map((bundle: { channel: string }) => bundle.channel);
      },

      async commitBundle(context, { changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        // Process each operation sequentially
        for (const op of changedSets) {
          if (op.operation === "delete") {
            // Handle delete operation
            const { error } = await context.supabase
              .from("bundles")
              .delete()
              .eq("id", op.data.id);

            if (error) {
              throw new Error(`Failed to delete bundle: ${error.message}`);
            }
          } else if (op.operation === "insert" || op.operation === "update") {
            // Handle insert and update operations
            const bundle = op.data;
            const { error } = await context.supabase.from("bundles").upsert(
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

        // Trigger hooks after all operations
        hooks?.onDatabaseUpdated?.();
      },

      // Native build operations
      async getNativeBuildById(context, nativeBuildId) {
        const { data, error } = await context.supabase
          .from("native_builds")
          .select("*")
          .eq("id", nativeBuildId)
          .single();

        if (!data || error) {
          return null;
        }

        return {
          id: data.id,
          nativeVersion: data.native_version,
          platform: data.platform,
          fingerprintHash: data.fingerprint_hash,
          storageUri: data.storage_uri,
          fileHash: data.file_hash,
          fileSize: data.file_size,
          channel: data.channel,
          metadata: data.metadata ?? {},
        } as NativeBuild;
      },

      async getNativeBuilds(
        context,
        options: {
          where?: {
            channel?: string;
            platform?: string;
            nativeVersion?: string;
          };
          limit: number;
          offset: number;
        },
      ) {
        const { where, limit, offset } = options ?? {};

        let countQuery = context.supabase
          .from("native_builds")
          .select("*", { count: "exact", head: true });

        if (where?.channel) {
          countQuery = countQuery.eq("channel", where.channel);
        }
        if (where?.platform) {
          countQuery = countQuery.eq("platform", where.platform);
        }
        if (where?.nativeVersion) {
          countQuery = countQuery.eq("native_version", where.nativeVersion);
        }

        const { count: total = 0 } = await countQuery;

        let query = context.supabase
          .from("native_builds")
          .select("*")
          .order("id", { ascending: false });

        if (where?.channel) {
          query = query.eq("channel", where.channel);
        }
        if (where?.platform) {
          query = query.eq("platform", where.platform);
        }
        if (where?.nativeVersion) {
          query = query.eq("native_version", where.nativeVersion);
        }

        if (limit) {
          query = query.limit(limit);
        }
        if (offset) {
          query = query.range(offset, offset + (limit || 20) - 1);
        }

        const { data } = await query;

        const nativeBuilds = data
          ? data.map((build) => ({
              id: build.id,
              nativeVersion: build.native_version,
              platform: build.platform,
              fingerprintHash: build.fingerprint_hash,
              storageUri: build.storage_uri,
              fileHash: build.file_hash,
              fileSize: build.file_size,
              channel: build.channel,
              metadata: build.metadata ?? {},
            }))
          : [];

        const pagination = calculatePagination(total ?? 0, { limit, offset });

        return {
          data: nativeBuilds,
          pagination,
        };
      },

      async updateNativeBuild(context, targetNativeBuildId, newNativeBuild) {
        const updateData: Partial<
          Database["public"]["Tables"]["native_builds"]["Update"]
        > = {};
        if (newNativeBuild.nativeVersion !== undefined)
          updateData.native_version = newNativeBuild.nativeVersion;
        if (newNativeBuild.platform !== undefined)
          updateData.platform = newNativeBuild.platform;
        if (newNativeBuild.fingerprintHash !== undefined)
          updateData.fingerprint_hash = newNativeBuild.fingerprintHash;
        if (newNativeBuild.storageUri !== undefined)
          updateData.storage_uri = newNativeBuild.storageUri;
        if (newNativeBuild.fileHash !== undefined)
          updateData.file_hash = newNativeBuild.fileHash;
        if (newNativeBuild.fileSize !== undefined)
          updateData.file_size = newNativeBuild.fileSize;
        if (newNativeBuild.channel !== undefined)
          updateData.channel = newNativeBuild.channel;
        if (newNativeBuild.metadata !== undefined)
          updateData.metadata = newNativeBuild.metadata;

        await context.supabase
          .from("native_builds")
          .update(updateData)
          .eq("id", targetNativeBuildId);
      },

      async appendNativeBuild(context, insertNativeBuild) {
        const insertData: Database["public"]["Tables"]["native_builds"]["Insert"] =
          {
            id: insertNativeBuild.id,
            native_version: insertNativeBuild.nativeVersion,
            platform: insertNativeBuild.platform,
            fingerprint_hash: insertNativeBuild.fingerprintHash,
            storage_uri: insertNativeBuild.storageUri,
            file_hash: insertNativeBuild.fileHash,
            file_size: insertNativeBuild.fileSize,
            channel: insertNativeBuild.channel,
            metadata: insertNativeBuild.metadata,
          };
        await context.supabase.from("native_builds").insert(insertData);
      },

      async deleteNativeBuild(context, deleteNativeBuild) {
        await context.supabase
          .from("native_builds")
          .delete()
          .eq("id", deleteNativeBuild.id);
      },
    },
    hooks,
  );
