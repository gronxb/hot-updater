import { filterCompatibleAppVersions } from "@hot-updater/js";
import { Platform, UpdateInfo, UpdateStatus } from "@hot-updater/core";

export const getUpdateInfo = async (
  DB: D1Database,
  { platform, appVersion, bundleId }: {
    platform: Platform;
    appVersion: string;
    bundleId: string;
  },
) => {
  const appVersionList = await DB.prepare(/* sql */ `
    SELECT 
      target_app_version
    FROM bundles
    WHERE platform = ?
    GROUP BY target_app_version
  `).bind(platform).all<{ target_app_version: string; count: number }>();

  const targetAppVersionList = filterCompatibleAppVersions(
    appVersionList.results.map((group) => group.target_app_version),
    appVersion,
  );


  const sql = /* sql */ `
  WITH input AS (
    SELECT 
      ? AS app_platform,       -- 예: 'ios' 또는 'android'
      ? AS app_version,        -- 예: '1.2.3'
      ? AS bundle_id,          -- 현재 번들 ID (문자열)
      '00000000-0000-0000-0000-000000000000' AS nil_uuid
  ),
  update_candidate AS (
    SELECT 
      b.id,
      b.should_force_update,
      b.file_url,
      b.file_hash,
      'UPDATE' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id >= input.bundle_id
      AND b.target_app_version IN (${targetAppVersionList.map(version => `'${version}'`).join(",")})
    ORDER BY b.id DESC 
    -- semver 규칙에 따라 최신 버전을 선택 로직 ㄱㄱ
    LIMIT 1
  ),
  rollback_candidate AS (
    SELECT 
      b.id,
      1 AS should_force_update,
      b.file_url,
      b.file_hash,
      'ROLLBACK' AS status
    FROM bundles b, input
    WHERE b.enabled = 1
      AND b.platform = input.app_platform
      AND b.id < input.bundle_id
    ORDER BY b.id DESC
    LIMIT 1
  ),
  final_result AS (
    SELECT * FROM update_candidate
    UNION ALL
    SELECT * FROM rollback_candidate
    WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
  )
  SELECT id, should_force_update, file_url, file_hash, status
  FROM final_result, input
  WHERE id <> bundle_id
  
  UNION ALL
  
  SELECT 
    nil_uuid AS id,
    1 AS should_force_update,
    NULL AS file_url,
    NULL AS file_hash,
    'ROLLBACK' AS status
  FROM input
  WHERE (SELECT COUNT(*) FROM final_result) = 0
    AND bundle_id <> nil_uuid;
        `;

  const result = await DB.prepare(sql)
    .bind(platform, appVersion, bundleId)
    .first<{
      id: string;
      should_force_update: number;
      file_url: string | null;
      file_hash: string | null;
      status: UpdateStatus;
    }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    shouldForceUpdate: Boolean(result.should_force_update),
    fileUrl: result.file_url,
    fileHash: result.file_hash,
    status: result.status,
  } as UpdateInfo;
};
