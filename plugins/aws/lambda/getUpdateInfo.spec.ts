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

// cdnBaseUrl을 받아서, bundles에 따른 fetch 응답을 mock한 후 getUpdateInfo를 호출하는 함수 생성
const createGetUpdateInfo =
  (cdnBaseUrl: string) =>
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
    // fetch 호출 시, URL 별로 반환할 데이터를 매핑
    const responses: Record<string, any> = {};

    if (bundles.length > 0) {
      // target-app-versions.json 응답 (중복 제거한 target 버전 배열)
      const targetVersions = [
        ...new Set(bundles.map((b) => b.targetAppVersion)),
      ];
      const targetVersionsPath = `${channel}/${platform}/target-app-versions.json`;
      const targetVersionsUrl = new URL(targetVersionsPath, cdnBaseUrl);
      targetVersionsUrl.searchParams.set(
        "token",
        await signToken(targetVersionsPath, "test-jwt-secret"),
      );
      responses[targetVersionsUrl.toString()] = targetVersions;

      // 각 target 버전별 update.json 응답 설정
      const bundlesByVersion: Record<string, Bundle[]> = {};
      for (const bundle of bundles) {
        if (!bundlesByVersion[bundle.targetAppVersion]) {
          bundlesByVersion[bundle.targetAppVersion] = [];
        }
        bundlesByVersion[bundle.targetAppVersion].push(bundle);
      }
      for (const targetVersion of targetVersions) {
        const updatePath = `${channel}/${platform}/${targetVersion}/update.json`;
        const updateUrl = new URL(updatePath, cdnBaseUrl);
        updateUrl.searchParams.set(
          "token",
          await signToken(updatePath, "test-jwt-secret"),
        );
        responses[updateUrl.toString()] = bundlesByVersion[targetVersion];
      }
    } else {
      // bundles가 없는 경우, 요청 시 Not Found로 처리하도록 함.
      // 테스트 환경에 따라 필요시 추가 검증 가능
      responses["*"] = null;
    }

    // global.fetch를 mock 처리 (요청 URL에 따라 적절한 응답 반환)
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

    // 기존 fetch를 백업 후, mock fetch로 교체
    const originalFetch = global.fetch;
    global.fetch = fetchMock as any;

    try {
      return await getUpdateInfoFromCdn(
        {
          cdnBaseUrl,
          jwtSecret: "test-jwt-secret",
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
      // 테스트 후 원래의 fetch로 복원
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
