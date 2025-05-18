import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
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
      id, file_hash, platform, target_app_version,
      should_force_update, enabled, git_commit_hash, message, channel
    ) VALUES (
      '${bundle.id}',
      '${bundle.fileHash}',
      '${bundle.platform}',
      '${bundle.targetAppVersion}',
      ${bundle.shouldForceUpdate},
      ${bundle.enabled},
      ${bundle.gitCommitHash ? `'${bundle.gitCommitHash}'` : "null"},
      ${bundle.message ? `'${bundle.message}'` : "null"},
      '${bundle.channel}'
    );
  `;
};

const createGetUpdateInfo =
  (db: D1Database) =>
  async (
    bundles: Bundle[],
    args: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    if (bundles.length > 0) {
      await db.prepare(createInsertBundleQuerys(bundles)).run();
    }
    return (await getUpdateInfoFromWorker(db, args)) as UpdateInfo | null;
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
