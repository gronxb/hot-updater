import {
  type AppVersionGetBundlesArgs,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/plugin-core";
import type { SupabaseClient } from "@supabase/supabase-js";
import camelcaseKeys from "camelcase-keys";

import type { Database } from "./types";

type UpdateInfoRow = {
  id: string;
  should_force_update: boolean;
  message: string;
  status: string;
  storage_uri: string | null;
  file_hash: string | null;
};

export const appVersionStrategy = async (
  supabase: SupabaseClient<Database>,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    cohort,
  }: AppVersionGetBundlesArgs,
) => {
  const { data: appVersionList, error: appVersionListError } =
    await supabase.rpc("get_target_app_version_list", {
      app_platform: platform,
      min_bundle_id: minBundleId,
    });

  if (appVersionListError) {
    throw appVersionListError;
  }

  const targetAppVersionList = filterCompatibleAppVersions(
    (appVersionList ?? []).map(
      (group: { target_app_version: string }) => group.target_app_version,
    ),
    appVersion,
  );

  const { data, error } = await supabase.rpc("get_update_info_by_app_version", {
    app_platform: platform,
    app_version: appVersion,
    bundle_id: bundleId,
    min_bundle_id: minBundleId,
    target_channel: channel,
    target_app_version_list: targetAppVersionList,
    cohort: cohort ?? null,
  });

  if (error) {
    throw error;
  }

  const row = (data as UpdateInfoRow[] | null)?.[0];
  return row ? (camelcaseKeys(row) as UpdateInfo) : null;
};

export const fingerprintStrategy = async (
  supabase: SupabaseClient<Database>,
  {
    platform,
    fingerprintHash,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    cohort,
  }: FingerprintGetBundlesArgs,
) => {
  const { data, error } = await supabase.rpc(
    "get_update_info_by_fingerprint_hash",
    {
      app_platform: platform,
      bundle_id: bundleId,
      min_bundle_id: minBundleId,
      target_channel: channel,
      target_fingerprint_hash: fingerprintHash,
      cohort: cohort ?? null,
    },
  );

  if (error) {
    throw error;
  }

  const row = (data as UpdateInfoRow[] | null)?.[0];
  return row ? (camelcaseKeys(row) as UpdateInfo) : null;
};

export const getUpdateInfo = (
  supabase: SupabaseClient<Database>,
  args: GetBundlesArgs,
) => {
  if (args._updateStrategy === "appVersion") {
    return appVersionStrategy(supabase, args);
  }

  return fingerprintStrategy(supabase, args);
};
