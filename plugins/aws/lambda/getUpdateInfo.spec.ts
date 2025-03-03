import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import { groupBy } from "es-toolkit";
import { describe } from "vitest";
import { getUpdateInfo } from "./getUpdateInfo";

const createGetUpdateInfo =
  (cloudfrontBaseUrl: string) =>
  async (
    bundles: Bundle[],
    { appVersion, bundleId, platform }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    const targetVersions = [...new Set(bundles.map((b) => b.targetAppVersion))];

    const responses = new Map<string, any>();
    responses.set(
      `${cloudfrontBaseUrl}/${platform}/target-app-versions.json`,
      targetVersions,
    );

    const bundlesByVersion = groupBy(bundles, (b) => b.targetAppVersion);
    for (const [version, versionBundles] of Object.entries(bundlesByVersion)) {
      responses.set(
        `${cloudfrontBaseUrl}/${platform}/${version}/update.json`,
        versionBundles,
      );
    }

    const originalFetch = global.fetch;
    global.fetch = async (input: string | URL | Request) => {
      if (responses.has(input.toString())) {
        return {
          ok: true,
          json: async () => responses.get(input.toString()),
        } as Response;
      }
      return {
        ok: false,
        json: async () => null,
      } as Response;
    };

    try {
      return await getUpdateInfo(cloudfrontBaseUrl, "", {
        appVersion,
        bundleId,
        platform,
      });
    } finally {
      global.fetch = originalFetch;
    }
  };

describe("getUpdateInfo", () => {
  setupGetUpdateInfoTestSuite({
    getUpdateInfo: createGetUpdateInfo("https://test.cloudfront.net"),
  });
});
