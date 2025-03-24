import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/core/test-utils";
import { signToken } from "@hot-updater/js";
import { beforeEach, describe, vi } from "vitest";
import { getUpdateInfo as getUpdateInfoFromCdn } from "./getUpdateInfo";

const createGetUpdateInfo =
  (baseUrl: string) =>
  async (
    bundles: Bundle[],
    {
      appVersion,
      bundleId,
      platform,
      minBundleId = NIL_UUID,
      channel = "production",
    }: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    const responses: Record<string, any> = {};

    if (bundles.length > 0) {
      const targetVersions = [
        ...new Set(bundles.map((b) => b.targetAppVersion)),
      ];
      const targetVersionsPath = `${channel}/${platform}/target-app-versions.json`;
      const targetVersionsUrl = new URL(baseUrl);
      targetVersionsUrl.pathname = `/${targetVersionsPath}`;
      targetVersionsUrl.searchParams.set(
        "token",
        await signToken(targetVersionsPath, "test-jwt-secret"),
      );
      responses[targetVersionsUrl.toString()] = targetVersions;

      const bundlesByVersion: Record<string, Bundle[]> = {};
      for (const bundle of bundles) {
        if (!bundlesByVersion[bundle.targetAppVersion]) {
          bundlesByVersion[bundle.targetAppVersion] = [];
        }
        bundlesByVersion[bundle.targetAppVersion].push(bundle);
      }
      for (const targetVersion of targetVersions) {
        const updatePath = `${channel}/${platform}/${targetVersion}/update.json`;
        const updateUrl = new URL(baseUrl);
        updateUrl.pathname = `/${updatePath}`;
        updateUrl.searchParams.set(
          "token",
          await signToken(updatePath, "test-jwt-secret"),
        );
        responses[updateUrl.toString()] = bundlesByVersion[targetVersion];
      }
    } else {
      responses["*"] = null;
    }

    const fetchMock = vi.fn(async (url: string) => {
      if (url in responses) {
        return {
          ok: true,
          json: async () => responses[url],
        };
      }
      return {
        ok: false,
        statusText: "Not Found",
      };
    });

    const originalFetch = global.fetch;
    global.fetch = fetchMock as any;

    try {
      return await getUpdateInfoFromCdn(
        {
          baseUrl,
          keyPairId: "test-key-pair-id",
          privateKey: "test-private-key",
        },
        {
          minBundleId,
          channel,
          appVersion,
          bundleId,
          platform,
        },
      );
    } finally {
      global.fetch = originalFetch;
    }
  };

describe("getUpdateInfo (CDN based)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: createGetUpdateInfo("https://test-cdn.com"),
  });
});
