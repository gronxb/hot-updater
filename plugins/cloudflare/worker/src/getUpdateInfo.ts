import {
  type AppVersionGetBundlesArgs,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";

const appVersionStrategy = async (
  DB: D1Database,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: AppVersionGetBundlesArgs,
) => {
  const appVersionList = await DB.prepare(
    /* sql */ `
    SELECT 
      target_app_version
    FROM bundles
    WHERE platform = ?
    GROUP BY target_app_version
  `,
  )
    .bind(platform)
    .all<{ target_app_version: string; count: number }>();

  const targetAppVersionList = filterCompatibleAppVersions(
    appVersionList.results.map((group) => group.target_app_version),
    appVersion,
  );

  const sql = /* sql */ `
  WITH input AS (
    SELECT 
      ? AS app_platform,
      ? AS app_version,
      ? AS bundle_id,
      ? AS min_bundle_id,
      ? AS channel,
      '00000000-0000-0000-0000-000000000000' AS nil_uuid
  ),
  update_candidate AS (
    SELECT 
      b.id,
      b.should_force_update,
      b.message,
      b.storage_uri,
      'UPDATE' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id >= input.bundle_id
      AND b.id >= input.min_bundle_id
      AND b.channel = input.channel
      AND b.target_app_version IN (${targetAppVersionList
        .map((version) => `'${version}'`)
        .join(",")})
    ORDER BY b.id DESC 
    LIMIT 1
  ),
  rollback_candidate AS (
    SELECT 
      b.id,
      1 AS should_force_update,
      b.message,
      b.storage_uri,
      'ROLLBACK' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id < input.bundle_id
      AND b.id >= input.min_bundle_id
    ORDER BY b.id DESC
    LIMIT 1
  ),
  final_result AS (
    SELECT * FROM update_candidate
    UNION ALL
    SELECT * FROM rollback_candidate
    WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
  )
  SELECT id, should_force_update, message, status, storage_uri
  FROM final_result, input
  WHERE id <> bundle_id
  
  UNION ALL
  
  SELECT 
    nil_uuid AS id,
    1 AS should_force_update,
    NULL AS message,
    'ROLLBACK' AS status,
    NULL AS storage_uri
  FROM input
  WHERE (SELECT COUNT(*) FROM final_result) = 0
    AND bundle_id > min_bundle_id;
`;

  const result = await DB.prepare(sql)
    .bind(platform, appVersion, bundleId, minBundleId, channel)
    .first<{
      id: string;
      should_force_update: number;
      status: UpdateStatus;
      message: string | null;
      storage_uri: string | null;
    }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    shouldForceUpdate: Boolean(result.should_force_update),
    status: result.status,
    message: result.message,
    storageUri: result.storage_uri,
  } as UpdateInfo;
};

export const fingerprintStrategy = async (
  DB: D1Database,
  {
    platform,
    fingerprintHash,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: FingerprintGetBundlesArgs,
) => {
  const sql = /* sql */ `
  WITH input AS (
    SELECT 
      ? AS app_platform,
      ? AS bundle_id,
      ? AS min_bundle_id,
      ? AS channel,
      ? AS fingerprint_hash,
      '00000000-0000-0000-0000-000000000000' AS nil_uuid
  ),
  update_candidate AS (
    SELECT 
      b.id,
      b.should_force_update,
      b.message,
      b.storage_uri,
      'UPDATE' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id >= input.bundle_id
      AND b.id >= input.min_bundle_id
      AND b.channel = input.channel
      AND b.fingerprint_hash = input.fingerprint_hash
    ORDER BY b.id DESC 
    LIMIT 1
  ),
  rollback_candidate AS (
    SELECT 
      b.id,
      1 AS should_force_update,
      b.message,
      b.storage_uri,
      'ROLLBACK' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id < input.bundle_id
      AND b.id >= input.min_bundle_id
      AND b.channel = input.channel
      AND b.fingerprint_hash = input.fingerprint_hash
    ORDER BY b.id DESC
    LIMIT 1
  ),
  final_result AS (
    SELECT * FROM update_candidate
    UNION ALL
    SELECT * FROM rollback_candidate
    WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
  )
  SELECT id, should_force_update, message, status, storage_uri
  FROM final_result, input
  WHERE id <> bundle_id
  
  UNION ALL
  
  SELECT 
    nil_uuid AS id,
    1 AS should_force_update,
    NULL AS message,
    'ROLLBACK' AS status,
    NULL AS storage_uri
  FROM input
  WHERE (SELECT COUNT(*) FROM final_result) = 0
    AND bundle_id > min_bundle_id;
`;

  const result = await DB.prepare(sql)
    .bind(platform, bundleId, minBundleId, channel, fingerprintHash)
    .first<{
      id: string;
      should_force_update: number;
      status: UpdateStatus;
      message: string | null;
      storage_uri: string | null;
    }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    shouldForceUpdate: Boolean(result.should_force_update),
    status: result.status,
    message: result.message,
    storageUri: result.storage_uri,
  } as UpdateInfo;
};

export const getUpdateInfo = (DB: D1Database, args: GetBundlesArgs) => {
  switch (args._updateStrategy) {
    case "appVersion":
      return appVersionStrategy(DB, args);
    case "fingerprint":
      return fingerprintStrategy(DB, args);
    default:
      return null;
  }
};
