import type {
  AppVersionGetBundlesArgs,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { beforeEach, describe, vi } from "vitest";
import { getUpdateInfo as getUpdateInfoFromCdn } from "./getUpdateInfo";

vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(({ url }) => url),
}));

const createGetUpdateInfo =
  (baseUrl: string) =>
  async (
    bundles: Bundle[],
    args: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    const responses: Record<string, any> = {};

    if (args._updateStrategy === "appVersion") {
      const { platform, channel = "production" } =
        args as AppVersionGetBundlesArgs;

      if (bundles.length > 0) {
        const targetVersions = [
          ...new Set(bundles.map((b) => b.targetAppVersion).filter(Boolean)),
        ];
        const targetVersionsPath = `${channel}/${platform}/target-app-versions.json`;
        const targetVersionsUrl = new URL(baseUrl);
        targetVersionsUrl.pathname = `/${targetVersionsPath}`;
        responses[targetVersionsUrl.toString()] = targetVersions;

        const bundlesByVersion: Record<string, Bundle[]> = {};
        for (const bundle of bundles) {
          if (!bundle.targetAppVersion) {
            continue;
          }

          if (!bundlesByVersion[bundle.targetAppVersion]) {
            bundlesByVersion[bundle.targetAppVersion] = [];
          }
          bundlesByVersion[bundle.targetAppVersion].push(bundle);
        }
        for (const targetVersion of targetVersions) {
          if (!targetVersion) {
            continue;
          }

          const updatePath = `${channel}/${platform}/${targetVersion}/update.json`;
          const updateUrl = new URL(baseUrl);
          updateUrl.pathname = `/${updatePath}`;
          responses[updateUrl.toString()] = bundlesByVersion[targetVersion];
        }
      }
    } else if (args._updateStrategy === "fingerprint") {
      for (const bundle of bundles) {
        if (!bundle.fingerprintHash) {
          continue;
        }

        const updatePath = `${bundle.channel}/${bundle.platform}/${bundle.fingerprintHash}/update.json`;
        const updateUrl = new URL(baseUrl);
        updateUrl.pathname = `/${updatePath}`;

        if (Array.isArray(responses[updateUrl.toString()])) {
          responses[updateUrl.toString()].push(bundle);
        } else {
          responses[updateUrl.toString()] = [bundle];
        }
        console.log("responses", responses);
      }
    } else {
      responses["*"] = null;
    }

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url in responses) {
        return new Response(JSON.stringify(responses[url]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(null, { status: 404, statusText: "Not Found" });
    });

    const originalFetch = global.fetch;
    global.fetch = fetchMock;

    try {
      return await getUpdateInfoFromCdn(
        {
          baseUrl,
          keyPairId: "test-key-pair-id",
          privateKey: "test-private-key",
        },
        args,
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
