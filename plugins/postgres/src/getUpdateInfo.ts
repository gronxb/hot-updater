import {
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import camelcaseKeys from "camelcase-keys";
import type pg from "pg";
import minify from "pg-minify";

export const getUpdateInfo = async (
  pool: pg.Pool,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: GetBundlesArgs,
) => {
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
    FROM get_update_info(
      $1, -- platform
      $2, -- appVersion
      $3, -- bundleId
      $4, -- minBundleId (nullable)
      $5, -- channel
      $6 -- targetAppVersionList (text array)
    );
  `);

  const result = await pool.query<{
    id: string;
    should_force_update: boolean;
    message: string;
    status: string;
  }>(sqlGetUpdateInfo, [
    platform,
    appVersion,
    bundleId,
    minBundleId ?? NIL_UUID,
    channel,
    targetAppVersionList,
  ]);

  return result.rows[0] ? (camelcaseKeys(result.rows[0]) as UpdateInfo) : null;
};
