import { NIL_UUID, type UpdateInfo } from "@hot-updater/core";
import type { GetBundlesArgs } from "@hot-updater/plugin-core";
import { filterCompatibleAppVersions } from "@hot-updater/plugin-core";
import type { SupabaseClient } from "@supabase/supabase-js";

import { throwSupabaseError } from "./supabaseResult";
import type { Database } from "./types";

type UpdateInfoRow =
  Database["public"]["Functions"]["get_update_info_by_app_version"]["Returns"][number];

const mapUpdateInfoRow = (row: UpdateInfoRow): UpdateInfo => ({
  id: row.id,
  shouldForceUpdate: row.should_force_update,
  message: row.message,
  status: row.status,
  storageUri: row.storage_uri,
  fileHash: row.file_hash,
});

export const createSupabaseGetUpdateInfo =
  (supabase: SupabaseClient<Database>) =>
  async (args: GetBundlesArgs): Promise<UpdateInfo | null> => {
    const channel = args.channel ?? "production";
    const minBundleId = args.minBundleId ?? NIL_UUID;
    if (args._updateStrategy === "appVersion") {
      const { data: targetVersions, error: targetVersionsError } =
        await supabase.rpc("get_target_app_version_list", {
          app_platform: args.platform,
          min_bundle_id: minBundleId,
        });
      throwSupabaseError("get target app version list", targetVersionsError);
      const compatibleVersions = filterCompatibleAppVersions(
        (targetVersions ?? [])
          .map(({ target_app_version }) => target_app_version)
          .filter((version): version is string => version !== null),
        args.appVersion,
      );
      const { data, error } = await supabase.rpc(
        "get_update_info_by_app_version",
        {
          app_platform: args.platform,
          app_version: args.appVersion,
          bundle_id: args.bundleId,
          min_bundle_id: minBundleId,
          target_channel: channel,
          target_app_version_list: compatibleVersions,
          cohort: args.cohort ?? null,
        },
      );
      throwSupabaseError("get update info by app version", error);
      const row = data?.[0];
      return row === undefined ? null : mapUpdateInfoRow(row);
    }
    const { data, error } = await supabase.rpc(
      "get_update_info_by_fingerprint_hash",
      {
        app_platform: args.platform,
        bundle_id: args.bundleId,
        min_bundle_id: minBundleId,
        target_channel: channel,
        target_fingerprint_hash: args.fingerprintHash,
        cohort: args.cohort ?? null,
      },
    );
    throwSupabaseError("get update info by fingerprint hash", error);
    const row = data?.[0];
    return row === undefined ? null : mapUpdateInfoRow(row);
  };
