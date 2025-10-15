import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { setupGetUpdateInfoIntegrationTestSuite } from "@hot-updater/core/test-utils";
import { beforeAll, beforeEach, describe, vi } from "vitest";
import { getUpdateInfo as getUpdateInfoFromCdn } from "./getUpdateInfo";

const BASE_URL = "https://test-cdn.cloudfront.net";
const KEY_PAIR_ID = "test-key-pair-id";
const PRIVATE_KEY = "test-private-key";

vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(({ url }) => url),
}));

let mockFetchResponses: Map<string, any> = new Map();

describe("AWS Lambda@Edge Integration Tests", () => {
  beforeAll(() => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const urlString = url.toString();

      if (mockFetchResponses.has(urlString)) {
        const data = mockFetchResponses.get(urlString);
        return {
          ok: true,
          json: async () => data,
        } as Response;
      }

      return {
        ok: false,
        statusText: "Not Found",
      } as Response;
    }) as any;
  });

  beforeEach(() => {
    mockFetchResponses.clear();
    vi.clearAllMocks();
  });

  setupGetUpdateInfoIntegrationTestSuite({
    setupBundles: async (bundles: Bundle[]) => {
      mockFetchResponses.clear();

      if (bundles.length === 0) return;

      const targetVersions = new Set<string>();
      const fingerprintHashes = new Set<string>();

      for (const bundle of bundles) {
        if (bundle.targetAppVersion) {
          targetVersions.add(bundle.targetAppVersion);
        }
        if (bundle.fingerprintHash) {
          fingerprintHashes.add(bundle.fingerprintHash);
        }
      }

      const channels = new Set(bundles.map((b) => b.channel));

      for (const channel of channels) {
        const platforms = new Set(bundles.map((b) => b.platform));

        for (const platform of platforms) {
          const platformTargetVersions = Array.from(targetVersions).filter((v) =>
            bundles.some(
              (b) =>
                b.targetAppVersion === v &&
                b.platform === platform &&
                b.channel === channel,
            ),
          );

          if (platformTargetVersions.length > 0) {
            const targetVersionsPath = `${channel}/${platform}/target-app-versions.json`;
            const targetVersionsUrl = new URL(BASE_URL);
            targetVersionsUrl.pathname = `/${targetVersionsPath}`;
            mockFetchResponses.set(
              targetVersionsUrl.toString(),
              platformTargetVersions,
            );

            const bundlesByVersion: Record<string, Bundle[]> = {};
            for (const bundle of bundles) {
              if (
                !bundle.targetAppVersion ||
                bundle.platform !== platform ||
                bundle.channel !== channel
              ) {
                continue;
              }

              if (!bundlesByVersion[bundle.targetAppVersion]) {
                bundlesByVersion[bundle.targetAppVersion] = [];
              }
              bundlesByVersion[bundle.targetAppVersion].push(bundle);
            }

            for (const targetVersion of platformTargetVersions) {
              const updatePath = `${channel}/${platform}/${targetVersion}/update.json`;
              const updateUrl = new URL(BASE_URL);
              updateUrl.pathname = `/${updatePath}`;
              mockFetchResponses.set(
                updateUrl.toString(),
                bundlesByVersion[targetVersion] || [],
              );
            }
          }

          for (const fingerprintHash of fingerprintHashes) {
            const fingerprintBundles = bundles.filter(
              (b) =>
                b.fingerprintHash === fingerprintHash &&
                b.platform === platform &&
                b.channel === channel,
            );

            if (fingerprintBundles.length > 0) {
              const updatePath = `${channel}/${platform}/${fingerprintHash}/update.json`;
              const updateUrl = new URL(BASE_URL);
              updateUrl.pathname = `/${updatePath}`;
              mockFetchResponses.set(updateUrl.toString(), fingerprintBundles);
            }
          }
        }
      }
    },

    cleanup: async () => {
      mockFetchResponses.clear();
    },

    fetchUpdateInfo: async (args: GetBundlesArgs): Promise<UpdateInfo | null> => {
      const result = await getUpdateInfoFromCdn(
        {
          baseUrl: BASE_URL,
          keyPairId: KEY_PAIR_ID,
          privateKey: PRIVATE_KEY,
        },
        args,
      );

      return result;
    },
  });
});
