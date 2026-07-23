import { PGlite } from "@electric-sql/pglite";
import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import camelcaseKeys from "camelcase-keys";
import { afterAll, beforeEach, describe } from "vitest";

import { prepareSql } from "./prepareSql";

const createInsertBundleQuery = (bundle: Bundle) => {
  const rolloutCohortCount = bundle.rolloutCohortCount ?? 1000;
  const targetCohorts = bundle.targetCohorts
    ? `ARRAY[${bundle.targetCohorts.map((id) => `'${id}'`).join(",")}]::TEXT[]`
    : "NULL";

  return `
    INSERT INTO bundles (
      id, file_hash, platform, target_app_version,
      should_force_update, enabled, git_commit_hash, message, channel, storage_uri, fingerprint_hash,
      rollout_cohort_count, target_cohorts
    ) VALUES (
      '${bundle.id}',
      '${bundle.fileHash}',
      '${bundle.platform}',
      ${bundle.targetAppVersion ? `'${bundle.targetAppVersion}'` : "null"},
      ${bundle.shouldForceUpdate},
      ${bundle.enabled},
      ${bundle.gitCommitHash ? `'${bundle.gitCommitHash}'` : "null"},
      ${bundle.message ? `'${bundle.message}'` : "null"},
      '${bundle.channel}',
      '${bundle.storageUri}',
      ${bundle.fingerprintHash ? `'${bundle.fingerprintHash}'` : "null"},
      ${rolloutCohortCount},
      ${targetCohorts}
    ) ON CONFLICT (id) DO UPDATE SET
      file_hash = EXCLUDED.file_hash,
      platform = EXCLUDED.platform,
      target_app_version = EXCLUDED.target_app_version,
      should_force_update = EXCLUDED.should_force_update,
      enabled = EXCLUDED.enabled,
      git_commit_hash = EXCLUDED.git_commit_hash,
      message = EXCLUDED.message,
      channel = EXCLUDED.channel,
      storage_uri = EXCLUDED.storage_uri,
      fingerprint_hash = EXCLUDED.fingerprint_hash,
      rollout_cohort_count = EXCLUDED.rollout_cohort_count,
      target_cohorts = EXCLUDED.target_cohorts;
  `;
};

const createGetUpdateInfo =
  (db: PGlite) =>
  async (
    bundles: Bundle[],
    args: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    const {
      bundleId,
      platform,
      minBundleId = NIL_UUID,
      channel = "production",
      _updateStrategy,
    } = args;
    await db.exec(createInsertBundleQuerys(bundles));

    if (_updateStrategy === "fingerprint") {
      const fingerprintHash = args.fingerprintHash;
      const cohort = args.cohort;
      const cohortSql = cohort ? `'${cohort}'` : "NULL";
      const result = await db.query<{
        id: string;
        should_force_update: boolean;
        message: string;
        status: string;
        storage_uri: string | null;
        file_hash: string | null;
      }>(
        `
      SELECT * FROM get_update_info_by_fingerprint_hash(
        '${platform}',
        '${bundleId}',
        '${minBundleId}',
        '${channel}',
        '${fingerprintHash}',
        ${cohortSql}
      );
      `,
      );

      if (!result.rows[0]) {
        return null;
      }

      const row = result.rows[0];
      return camelcaseKeys(row) as UpdateInfo;
    }

    const appVersion = args.appVersion;
    const { rows: appVersionList } = await db.query<{
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

    const cohort = args.cohort;
    const cohortSql = cohort ? `'${cohort}'` : "NULL";
    const result = await db.query<{
      id: string;
      should_force_update: boolean;
      message: string;
      status: string;
      storage_uri: string | null;
      file_hash: string | null;
    }>(
      `
      SELECT * FROM get_update_info_by_app_version(
        '${platform}',
        '${appVersion}',
        '${bundleId}',
        '${minBundleId ?? NIL_UUID}',
        '${channel}',
        ARRAY[${targetAppVersionList.map((v) => `'${v}'`).join(",")}]::text[],
        ${cohortSql}
      );
      `,
    );

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0];
    return camelcaseKeys(row) as UpdateInfo;
  };

const createInsertBundleQuerys = (bundles: Bundle[]) => {
  return bundles.map(createInsertBundleQuery).join("\n");
};

const db = new PGlite();

const sql = await prepareSql();
await db.exec(sql);
const getUpdateInfo = createGetUpdateInfo(db);

describe("getUpdateInfo", () => {
  beforeEach(async () => {
    await db.exec("DELETE FROM bundle_patches");
    await db.exec("DELETE FROM bundles");
  });

  afterAll(async () => {
    await db.close();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: getUpdateInfo,
  });
});
