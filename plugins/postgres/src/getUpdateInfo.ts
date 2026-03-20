import {
  type AppVersionGetBundlesArgs,
  type GetBundlesArgs,
  maskUuidV7Rand,
  maskUuidV7RandUpper,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import camelcaseKeys from "camelcase-keys";
import type pg from "pg";
import minify from "pg-minify";

export const appVersionStrategy = async (
  pool: pg.Pool,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: AppVersionGetBundlesArgs,
) => {
  const maskedBundleIdLower = maskUuidV7Rand(bundleId);
  const maskedBundleIdUpper = maskUuidV7RandUpper(bundleId);

  const sqlGetTargetAppVersionList = minify(`
    SELECT target_app_version
    FROM get_target_app_version_list($1, $2);
  `);

  const { rows: appVersionList } = await pool.query<{
    target_app_version: string;
  }>(sqlGetTargetAppVersionList, [platform, minBundleId]);

  const targetAppVersionList = filterCompatibleAppVersions(
    appVersionList?.map((group) => group.target_app_version) ?? [],
    appVersion,
  );

  const sqlGetUpdateInfo = minify(`
    SELECT *
    FROM get_update_info_by_app_version(
      $1, -- platform
      $2, -- appVersion
      $3, -- maskedBundleIdLower
      $4, -- maskedBundleIdUpper
      $5, -- minBundleId
      $6, -- channel
      $7  -- targetAppVersionList (text array)
    );
  `);

  const result = await pool.query<{
    id: string;
    should_force_update: boolean;
    message: string;
    status: string;
    storage_uri: string | null;
    file_hash: string | null;
  }>(sqlGetUpdateInfo, [
    platform,
    appVersion,
    maskedBundleIdLower,
    maskedBundleIdUpper,
    minBundleId ?? NIL_UUID,
    channel,
    targetAppVersionList,
  ]);

  return result.rows[0] ? (camelcaseKeys(result.rows[0]) as UpdateInfo) : null;
};

export const getUpdateInfo = (pool: pg.Pool, args: GetBundlesArgs) => {
  if (args._updateStrategy === "appVersion") {
    return appVersionStrategy(pool, args);
  }

  // TODO:
  // return fingerprintStrategy(bundles, args);
  return null;
};
