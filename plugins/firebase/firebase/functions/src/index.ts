import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type Platform,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import admin from "firebase-admin";
import functions from "firebase-functions";

admin.initializeApp();
const db = admin.firestore();

// 버전 호환성 확인 함수
const isAppVersionCompatible = (
  targetAppVersion: string,
  appVersion: string,
): boolean => {
  console.log(
    `Checking compatibility: appVersion=${appVersion}, targetAppVersion=${targetAppVersion}`,
  );
  // appVersion이 targetAppVersion보다 낮거나 같으면 호환
  return appVersion <= targetAppVersion;
};

// 롤백 여부 확인 함수
const checkForRollback = (
  filteredBundles: Bundle[],
  bundleId: string,
): boolean => {
  // 현재 bundleId가 NIL_UUID인 경우 롤백 불가
  if (bundleId === NIL_UUID) {
    return false;
  }
  // 호환되는 번들이 없으면 롤백
  return filteredBundles.length === 0;
};

// 최신 번들 찾기 함수
const findLatestBundles = (bundles: Bundle[]) => {
  return (
    bundles
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.id.localeCompare(a.id))?.[0] ?? null
  );
};

// 업데이트 정보 반환 함수
export const getUpdateInfo = async (
  bundles: Bundle[],
  { platform, bundleId, appVersion }: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  console.log("getUpdateInfo input bundles:", bundles);

  // 호환되는 번들 필터링
  const filteredBundles = bundles.filter((b) => {
    const compatible =
      b.platform === platform &&
      isAppVersionCompatible(b.targetAppVersion, appVersion);
    return compatible;
  });
  console.log("filteredBundles:", filteredBundles);

  // 롤백 여부 확인
  const isRollback = checkForRollback(filteredBundles, bundleId);
  console.log(`getUpdateInfo: isRollback=${isRollback}`);

  // 최신 번들 찾기
  const latestBundle = findLatestBundles(filteredBundles);
  console.log(`getUpdateInfo: latestBundle=${JSON.stringify(latestBundle)}`);

  // 최신 번들이 없는 경우
  if (!latestBundle) {
    console.log("getUpdateInfo: No latestBundle found.");
    if (isRollback) {
      console.log(
        "getUpdateInfo: No latestBundle and isRollback - returning ROLLBACK",
      );
      return {
        id: NIL_UUID,
        shouldForceUpdate: true,
        fileUrl: null,
        fileHash: null,
        status: "ROLLBACK" as UpdateStatus,
      };
    }
    console.log(
      "getUpdateInfo: No latestBundle and not isRollback - returning null (NO_UPDATE)",
    );
    return null; // NO_UPDATE
  }

  // appVersion이 targetAppVersion보다 높거나 같은 경우 업데이트
  if (latestBundle.id.localeCompare(bundleId) > 0) {
    console.log("getUpdateInfo: latestBundle.id > bundleId, returning UPDATE");
    return {
      id: latestBundle.id,
      shouldForceUpdate: Boolean(latestBundle.shouldForceUpdate),
      fileUrl: latestBundle.fileUrl || null,
      fileHash: latestBundle.fileHash || null,
      status: "UPDATE" as UpdateStatus,
    };
  }

  console.log("getUpdateInfo: No conditions met, returning null (NO_UPDATE)");
  return null; // NO_UPDATE
};

// Firebase 함수로 업데이트 정보 제공
export const updateInfoFunction = functions.https.onRequest(
  { region: "asia-northeast3" },
  async (req, res) => {
    try {
      const platformHeader = req.headers["x-app-platform"] as string;
      const appVersion = req.headers["x-app-version"] as string;
      const bundleId = req.headers["x-bundle-id"] as string;

      // 필수 헤더 확인
      if (!platformHeader || !appVersion || !bundleId) {
        res
          .status(400)
          .send(
            "Missing required headers (x-app-platform, x-app-version, x-bundle-id)",
          );
        return;
      }

      // 플랫폼 유효성 검사
      const platform = validatePlatform(platformHeader);
      if (!platform) {
        res
          .status(400)
          .send("Invalid platform. Must be 'ios', 'android', or 'web'");
        return;
      }

      // Firestore에서 번들 조회
      const bundlesRef = db.collection("bundles");
      const bundlesSnapshot = await bundlesRef.get();

      const bundles: Bundle[] = bundlesSnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: data.id,
          fileUrl: data.file_url,
          fileHash: data.file_hash,
          platform: validatePlatform(data.platform) || "ios",
          targetAppVersion: data.target_app_version,
          shouldForceUpdate: Boolean(data.should_force_update),
          enabled: Boolean(data.enabled),
          gitCommitHash: data.git_commit_hash || null,
          message: data.message || null,
        } as Bundle;
      });
      console.log("Fetched bundles from Firestore:", bundles);

      // 업데이트 정보 조회
      const result = await getUpdateInfo(bundles, {
        platform,
        appVersion,
        bundleId,
      });

      // 응답 데이터 구성
      const responseData = result || {
        id: NIL_UUID,
        shouldForceUpdate: false,
        fileUrl: null,
        fileHash: null,
        status: "NO_UPDATE" as UpdateStatus,
      };

      res.status(200).json(responseData);
    } catch (error) {
      console.error("Update info error:", error);
      res.status(500).send("Internal Server Error");
    }
  },
);

// 플랫폼 유효성 검사 함수
function validatePlatform(platform: string): Platform | null {
  const validPlatforms: Platform[] = ["ios", "android"];
  return validPlatforms.includes(platform as Platform)
    ? (platform as Platform)
    : null;
}
