import { filterCompatibleAppVersions } from "@hot-updater/js";
import {
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import camelcaseKeys from "camelcase-keys";
import pg from "pg";

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
  const { rows: appVersionList } = await pool.query<{
    target_app_version: string;
  }>(
    `
       SELECT target_app_version FROM get_target_app_version_list('${platform}', '${minBundleId}');
       `,
  );

  const targetAppVersionList = filterCompatibleAppVersions(
    appVersionList?.map((group) => group.target_app_version) ?? [],
    appVersion,
  );

  const result = await pool.query<{
    id: string;
    should_force_update: boolean;
    message: string;
    status: string;
  }>(
    `
       SELECT * FROM get_update_info(
         '${platform}',
         '${appVersion}',
         '${bundleId}',
         '${minBundleId ?? NIL_UUID}',
         '${channel}',
         ARRAY[${targetAppVersionList.map((v) => `'${v}'`).join(",")}]::text[]
       );
       `,
  );

  return result.rows[0] ? (camelcaseKeys(result.rows[0]) as UpdateInfo) : null;
};
