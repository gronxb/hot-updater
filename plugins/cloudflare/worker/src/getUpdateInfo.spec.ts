import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import { beforeAll, beforeEach, describe, inject } from "vitest";
import { getUpdateInfo as getUpdateInfoFromWorker } from "./getUpdateInfo";

import { env } from "cloudflare:test";

declare module "vitest" {
  // biome-ignore lint/suspicious/noExportsInTest: <explanation>
  export interface ProvidedContext {
    prepareSql: string;
  }
}
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

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
  (db: D1Database) =>
  async (
    bundles: Bundle[],
    { appVersion, bundleId, platform, minBundleId }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    if (bundles.length > 0) {
      await db.prepare(createInsertBundleQuerys(bundles)).run();
    }
    return (await getUpdateInfoFromWorker(db, {
      appVersion,
      bundleId,
      platform,
      minBundleId: minBundleId || NIL_UUID,
    })) as UpdateInfo | null;
  };

const createInsertBundleQuerys = (bundles: Bundle[]) => {
  return bundles.map(createInsertBundleQuery).join("\n");
};

const getUpdateInfo = createGetUpdateInfo(env.DB);

describe("getUpdateInfo", async () => {
  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bundles").run();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: getUpdateInfo,
  });
});
