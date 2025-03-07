import { PGlite } from "@electric-sql/pglite";
import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import camelcaseKeys from "camelcase-keys";
import { afterAll, beforeEach, describe } from "vitest";
import { prepareSql } from "./prepareSql";

const createInsertBundleQuery = (bundle: Bundle) => {
  return `
    INSERT INTO bundles (
      id, file_url, file_hash, platform, target_app_version,
      should_force_update, enabled, git_commit_hash, message
    ) VALUES (
      '${bundle.id}',
      '${bundle.fileUrl}',
      '${bundle.fileHash}',
      '${bundle.platform}',
      '${bundle.targetAppVersion}',
      ${bundle.shouldForceUpdate},
      ${bundle.enabled},
      ${bundle.gitCommitHash ? `'${bundle.gitCommitHash}'` : "null"},
      ${bundle.message ? `'${bundle.message}'` : "null"}
    );
  `;
};

const createGetUpdateInfo =
  (db: PGlite) =>
  async (
    bundles: Bundle[],
    { appVersion, bundleId, platform, minBundleId }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    await db.exec(createInsertBundleQuerys(bundles));

    const result = await db.query<{
      id: string;
      should_force_update: boolean;
      file_url: string;
      file_hash: string;
      status: string;
    }>(
      `
      SELECT * FROM get_update_info('${platform}', '${appVersion}', '${bundleId}', '${minBundleId ?? NIL_UUID}')
    `,
    );

    return result.rows[0]
      ? (camelcaseKeys(result.rows[0]) as UpdateInfo)
      : null;
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
    await db.exec("DELETE FROM bundles");
  });

  afterAll(async () => {
    await db.close();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: getUpdateInfo,
  });
});
