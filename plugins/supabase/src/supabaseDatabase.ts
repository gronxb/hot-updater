import type {
  Bundle,
  DeviceEvent,
  DeviceEventFilter,
  DeviceEventListResult,
  Platform,
  RolloutStats,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";
import { uuidv7 } from "uuidv7";
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
            "channel, enabled, should_force_update, file_hash, git_commit_hash, id, message, platform, target_app_version, fingerprint_hash, storage_uri, metadata, rollout_percentage, target_device_ids",
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
          rolloutPercentage: data.rollout_percentage ?? 100,
          targetDeviceIds: data.target_device_ids ?? null,
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
            "id, channel, enabled, platform, should_force_update, file_hash, git_commit_hash, message, fingerprint_hash, target_app_version, storage_uri, metadata, rollout_percentage, target_device_ids",
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
              rolloutPercentage: bundle.rollout_percentage ?? 100,
              targetDeviceIds: bundle.target_device_ids ?? null,
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
                rollout_percentage: bundle.rolloutPercentage ?? 100,
                target_device_ids: bundle.targetDeviceIds ?? null,
              },
              { onConflict: "id" },
            );

            if (error) {
              throw error;
            }
          }
        }
      },

      async trackDeviceEvent(event: DeviceEvent): Promise<void> {
        const { error } = await supabase.from("device_events").insert({
          id: uuidv7(),
          device_id: event.deviceId,
          bundle_id: event.bundleId,
          event_type: event.eventType,
          platform: event.platform,
          app_version: event.appVersion ?? null,
          channel: event.channel,
          metadata: event.metadata ?? {},
        });

        if (error) {
          throw new Error(`Failed to track event: ${error.message}`);
        }
      },

      async getRolloutStats(bundleId: string): Promise<RolloutStats> {
        const { data, error } = await supabase
          .rpc("get_rollout_stats", { target_bundle_id: bundleId })
          .single();

        if (error) {
          throw new Error(`Failed to get rollout stats: ${error.message}`);
        }

        type RolloutStatsRow = {
          total_devices: number | null;
          promoted_count: number | null;
          recovered_count: number | null;
          success_rate: number | null;
        };

        const row = data as RolloutStatsRow | null;

        return {
          totalDevices: Number(row?.total_devices ?? 0),
          promotedCount: Number(row?.promoted_count ?? 0),
          recoveredCount: Number(row?.recovered_count ?? 0),
          successRate: Number(row?.success_rate ?? 0),
        };
      },

      async getDeviceEvents(
        filter?: DeviceEventFilter,
      ): Promise<DeviceEventListResult> {
        const limit = filter?.limit ?? 50;
        const offset = filter?.offset ?? 0;

        let countQuery = supabase
          .from("device_events")
          .select("*", { count: "exact", head: true });

        if (filter?.bundleId) {
          countQuery = countQuery.eq("bundle_id", filter.bundleId);
        }
        if (filter?.platform) {
          countQuery = countQuery.eq("platform", filter.platform);
        }
        if (filter?.channel) {
          countQuery = countQuery.eq("channel", filter.channel);
        }
        if (filter?.eventType) {
          countQuery = countQuery.eq("event_type", filter.eventType);
        }

        const { count: total = 0 } = await countQuery;

        let query = supabase
          .from("device_events")
          .select(
            "id, device_id, bundle_id, event_type, platform, app_version, channel, metadata",
          )
          .order("id", { ascending: false });

        if (filter?.bundleId) {
          query = query.eq("bundle_id", filter.bundleId);
        }
        if (filter?.platform) {
          query = query.eq("platform", filter.platform);
        }
        if (filter?.channel) {
          query = query.eq("channel", filter.channel);
        }
        if (filter?.eventType) {
          query = query.eq("event_type", filter.eventType);
        }

        query = query.range(offset, offset + limit - 1);

        const { data, error } = await query;

        if (error) {
          throw new Error(`Failed to get device events: ${error.message}`);
        }

        const events: DeviceEvent[] = (data ?? []).map((row) => ({
          id: row.id,
          deviceId: row.device_id,
          bundleId: row.bundle_id,
          eventType: row.event_type as "PROMOTED" | "RECOVERED",
          platform: row.platform as Platform,
          appVersion: row.app_version ?? undefined,
          channel: row.channel,
          metadata: (row.metadata as Record<string, unknown>) ?? undefined,
        }));

        const pagination = calculatePagination(total ?? 0, { limit, offset });

        return {
          data: events,
          pagination,
        };
      },
    };
  },
});
