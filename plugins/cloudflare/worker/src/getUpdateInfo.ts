import {
  type AppVersionGetBundlesArgs,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";

function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash % 100);
}

function isDeviceEligibleForUpdate(
  userId: string,
  rolloutPercentage: number | null | undefined,
  targetDeviceIds: string[] | null | undefined,
): boolean {
  if (targetDeviceIds && targetDeviceIds.length > 0) {
    return targetDeviceIds.includes(userId);
  }

  if (
    rolloutPercentage === null ||
    rolloutPercentage === undefined ||
    rolloutPercentage >= 100
  ) {
    return true;
  }

  if (rolloutPercentage <= 0) {
    return false;
  }

  const userHash = hashUserId(userId);
  return userHash < rolloutPercentage;
}

const parseTargetDeviceIds = (value: string | null): string[] | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    return null;
  }
  return null;
};

const appVersionStrategy = async (
  DB: D1Database,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    deviceId,
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
      b.file_hash,
      b.rollout_percentage,
      b.target_device_ids,
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
      b.file_hash,
      b.rollout_percentage,
      b.target_device_ids,
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
  SELECT id, should_force_update, message, status, storage_uri, file_hash, rollout_percentage, target_device_ids
  FROM final_result, input
  WHERE id <> bundle_id

  UNION ALL

  SELECT
    nil_uuid AS id,
    1 AS should_force_update,
    NULL AS message,
    'ROLLBACK' AS status,
    NULL AS storage_uri,
    NULL AS file_hash,
    NULL AS rollout_percentage,
    NULL AS target_device_ids
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
      file_hash: string | null;
      rollout_percentage: number | null;
      target_device_ids: string | null;
    }>();

  if (!result) {
    return null;
  }

  if (deviceId && result.status === "UPDATE") {
    const eligible = isDeviceEligibleForUpdate(
      deviceId,
      result.rollout_percentage,
      parseTargetDeviceIds(result.target_device_ids),
    );

    if (!eligible) {
      return null;
    }
  }

  return {
    id: result.id,
    shouldForceUpdate: Boolean(result.should_force_update),
    status: result.status,
    message: result.message,
    storageUri: result.storage_uri,
    fileHash: result.file_hash,
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
    deviceId,
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
      b.file_hash,
      b.rollout_percentage,
      b.target_device_ids,
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
      b.file_hash,
      b.rollout_percentage,
      b.target_device_ids,
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
  SELECT id, should_force_update, message, status, storage_uri, file_hash, rollout_percentage, target_device_ids
  FROM final_result, input
  WHERE id <> bundle_id

  UNION ALL

  SELECT
    nil_uuid AS id,
    1 AS should_force_update,
    NULL AS message,
    'ROLLBACK' AS status,
    NULL AS storage_uri,
    NULL AS file_hash,
    NULL AS rollout_percentage,
    NULL AS target_device_ids
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
      file_hash: string | null;
      rollout_percentage: number | null;
      target_device_ids: string | null;
    }>();

  if (!result) {
    return null;
  }

  if (deviceId && result.status === "UPDATE") {
    const eligible = isDeviceEligibleForUpdate(
      deviceId,
      result.rollout_percentage,
      parseTargetDeviceIds(result.target_device_ids),
    );

    if (!eligible) {
      return null;
    }
  }

  return {
    id: result.id,
    shouldForceUpdate: Boolean(result.should_force_update),
    status: result.status,
    message: result.message,
    storageUri: result.storage_uri,
    fileHash: result.file_hash,
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
