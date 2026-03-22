import {
  type AppVersionGetBundlesArgs,
  type Bundle,
  DEFAULT_ROLLOUT_COHORT_COUNT,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  NIL_UUID,
} from "@hot-updater/core";
import {
  filterCompatibleAppVersions,
  getUpdateInfo as getUpdateInfoJS,
} from "@hot-updater/js";

const parseTargetCohorts = (value: string | null): string[] | null => {
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

type BundleRow = {
  id: string;
  platform: Bundle["platform"];
  should_force_update: number;
  enabled: number;
  file_hash: string;
  git_commit_hash: string | null;
  message: string | null;
  channel: string;
  storage_uri: string;
  target_app_version: string | null;
  fingerprint_hash: string | null;
  rollout_cohort_count: number | null;
  target_cohorts: string | null;
};

const convertToBundle = (row: BundleRow): Bundle => ({
  id: row.id,
  platform: row.platform,
  shouldForceUpdate: Boolean(row.should_force_update),
  enabled: Boolean(row.enabled),
  fileHash: row.file_hash,
  gitCommitHash: row.git_commit_hash,
  message: row.message,
  channel: row.channel,
  storageUri: row.storage_uri,
  targetAppVersion: row.target_app_version,
  fingerprintHash: row.fingerprint_hash,
  rolloutCohortCount: row.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  targetCohorts: parseTargetCohorts(row.target_cohorts),
});

const appVersionStrategy = async (
  DB: D1Database,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    cohort,
  }: AppVersionGetBundlesArgs,
) => {
  const appVersionList = await DB.prepare(
    /* sql */ `
    SELECT 
      target_app_version
    FROM bundles
    WHERE platform = ?
      AND channel = ?
      AND enabled = 1
      AND id >= ?
      AND target_app_version IS NOT NULL
    GROUP BY target_app_version
  `,
  )
    .bind(platform, channel, minBundleId)
    .all<{ target_app_version: string; count: number }>();

  const targetAppVersionList = filterCompatibleAppVersions(
    appVersionList.results.map((group) => group.target_app_version),
    appVersion,
  );

  if (targetAppVersionList.length === 0) {
    return getUpdateInfoJS([], {
      platform,
      appVersion,
      bundleId,
      minBundleId,
      channel,
      cohort,
      _updateStrategy: "appVersion",
    });
  }

  const placeholders = targetAppVersionList.map(() => "?").join(", ");
  const rows = await DB.prepare(
    /* sql */ `
    SELECT
      id,
      platform,
      should_force_update,
      enabled,
      file_hash,
      git_commit_hash,
      message,
      channel,
      storage_uri,
      target_app_version,
      fingerprint_hash,
      rollout_cohort_count,
      target_cohorts
    FROM bundles
    WHERE enabled = 1
      AND platform = ?
      AND id >= ?
      AND channel = ?
      AND target_app_version IN (${placeholders})
  `,
  )
    .bind(platform, minBundleId, channel, ...targetAppVersionList)
    .all<BundleRow>();

  return getUpdateInfoJS(rows.results.map(convertToBundle), {
    platform,
    appVersion,
    bundleId,
    minBundleId,
    channel,
    cohort,
    _updateStrategy: "appVersion",
  });
};

export const fingerprintStrategy = async (
  DB: D1Database,
  {
    platform,
    fingerprintHash,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    cohort,
  }: FingerprintGetBundlesArgs,
) => {
  const rows = await DB.prepare(
    /* sql */ `
    SELECT
      id,
      platform,
      should_force_update,
      enabled,
      file_hash,
      git_commit_hash,
      message,
      channel,
      storage_uri,
      target_app_version,
      fingerprint_hash,
      rollout_cohort_count,
      target_cohorts
    FROM bundles
    WHERE enabled = 1
      AND platform = ?
      AND id >= ?
      AND channel = ?
      AND fingerprint_hash = ?
  `,
  )
    .bind(platform, minBundleId, channel, fingerprintHash)
    .all<BundleRow>();

  return getUpdateInfoJS(rows.results.map(convertToBundle), {
    platform,
    fingerprintHash,
    bundleId,
    minBundleId,
    channel,
    cohort,
    _updateStrategy: "fingerprint",
  });
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
