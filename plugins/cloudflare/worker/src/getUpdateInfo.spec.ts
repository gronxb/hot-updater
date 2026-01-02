import { env } from "cloudflare:test";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { isDeviceEligibleForUpdate } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { beforeAll, beforeEach, describe, inject } from "vitest";
import { getUpdateInfo as getUpdateInfoFromWorker } from "./getUpdateInfo";

declare module "vitest" {
  // biome-ignore lint/suspicious/noExportsInTest: extending test context
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
  const rolloutPercentage = bundle.rolloutPercentage ?? 100;
  const targetDeviceIds = bundle.targetDeviceIds
    ? `'${JSON.stringify(bundle.targetDeviceIds)}'`
    : "null";

  return `
    INSERT INTO bundles (
      id, file_hash, platform, target_app_version,
      should_force_update, enabled, git_commit_hash, message, channel,
      storage_uri, fingerprint_hash, rollout_percentage, target_device_ids
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
      ${bundle.storageUri ? `'${bundle.storageUri}'` : "null"},
      ${bundle.fingerprintHash ? `'${bundle.fingerprintHash}'` : "null"},
      ${rolloutPercentage},
      ${targetDeviceIds}
    ) ON CONFLICT(id) DO UPDATE SET
      file_hash = excluded.file_hash,
      platform = excluded.platform,
      target_app_version = excluded.target_app_version,
      should_force_update = excluded.should_force_update,
      enabled = excluded.enabled,
      git_commit_hash = excluded.git_commit_hash,
      message = excluded.message,
      channel = excluded.channel,
      storage_uri = excluded.storage_uri,
      fingerprint_hash = excluded.fingerprint_hash,
      rollout_percentage = excluded.rollout_percentage,
      target_device_ids = excluded.target_device_ids;
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
    const result = (await getUpdateInfoFromWorker(db, args)) as UpdateInfo | null;

    if (result && args.deviceId && result.status === "UPDATE") {
      const eligible = isDeviceEligibleForUpdate(
        args.deviceId,
        result.rolloutPercentage,
        result.targetDeviceIds,
      );

      if (!eligible) {
        return null;
      }
    }

    return result;
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
