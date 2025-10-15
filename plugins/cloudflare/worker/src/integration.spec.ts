import { env, SELF } from "cloudflare:test";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { setupGetUpdateInfoIntegrationTestSuite } from "@hot-updater/core/test-utils";
import { beforeAll, beforeEach, describe, inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    prepareSql: string;
  }
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    JWT_SECRET: string;
  }
}

const createInsertBundleQuery = (bundle: Bundle) => {
  return `
    INSERT INTO bundles (
      id, file_hash, platform, target_app_version,
      should_force_update, enabled, git_commit_hash, message, channel,
      storage_uri, fingerprint_hash
    ) VALUES (
      '${bundle.id}',
      '${bundle.fileHash}',
      '${bundle.platform}',
      ${bundle.targetAppVersion ? `'${bundle.targetAppVersion}'` : "null"},
      ${bundle.shouldForceUpdate ? 1 : 0},
      ${bundle.enabled ? 1 : 0},
      ${bundle.gitCommitHash ? `'${bundle.gitCommitHash}'` : "null"},
      ${bundle.message ? `'${bundle.message}'` : "null"},
      '${bundle.channel}',
      ${bundle.storageUri ? `'${bundle.storageUri}'` : "null"},
      ${bundle.fingerprintHash ? `'${bundle.fingerprintHash}'` : "null"}
    );
  `;
};

const createInsertBundleQuerys = (bundles: Bundle[]) => {
  return bundles.map(createInsertBundleQuery).join("\n");
};

describe("Cloudflare Workers Integration Tests", async () => {
  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bundles").run();
  });

  setupGetUpdateInfoIntegrationTestSuite({
    setupBundles: async (bundles: Bundle[]) => {
      if (bundles.length > 0) {
        await env.DB.prepare(createInsertBundleQuerys(bundles)).run();
      }
    },

    cleanup: async () => {
      await env.DB.prepare("DELETE FROM bundles").run();
    },

    fetchUpdateInfo: async (args: GetBundlesArgs): Promise<UpdateInfo | null> => {
      const headers: Record<string, string> = {
        "x-bundle-id": args.bundleId,
        "x-app-platform": args.platform,
      };

      if (args._updateStrategy === "appVersion") {
        headers["x-app-version"] = args.appVersion;
      } else {
        headers["x-fingerprint-hash"] = args.fingerprintHash;
      }

      if (args.minBundleId && args.minBundleId !== NIL_UUID) {
        headers["x-min-bundle-id"] = args.minBundleId;
      }

      if (args.channel) {
        headers["x-channel"] = args.channel;
      }

      const response = await SELF.fetch("http://localhost/api/check-update", {
        headers,
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (!data || !data.id) {
        return null;
      }

      return {
        id: data.id,
        shouldForceUpdate: data.shouldForceUpdate,
        status: data.status,
        message: data.message,
        storageUri: data.storageUri,
      };
    },
  });
});
