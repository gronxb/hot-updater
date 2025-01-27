import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import Database from "better-sqlite3";
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
  (db: Database) =>
  async (
    bundles: Bundle[],
    { appVersion, bundleId, platform }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    db.exec(createInsertBundleQuerys(bundles));

    const result = db
      .prepare(`
      SELECT * FROM get_update_info(?, ?, ?)
    `)
      .get(platform, appVersion, bundleId);

    return result ? (camelcaseKeys(result) as UpdateInfo) : null;
  };

const createInsertBundleQuerys = (bundles: Bundle[]) => {
  return bundles.map(createInsertBundleQuery).join("\n");
};

const db = new Database(":memory:");

const sql = await prepareSql();
db.exec(sql);
const getUpdateInfo = createGetUpdateInfo(db);

describe("getUpdateInfo", () => {
  beforeEach(() => {
    db.exec("DELETE FROM bundles");
  });

  afterAll(() => {
    db.close();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: getUpdateInfo,
  });
});
