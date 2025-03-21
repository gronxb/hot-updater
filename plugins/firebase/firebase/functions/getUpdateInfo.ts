import {
  NIL_UUID,
  type Platform,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { Firestore } from "firebase-admin/firestore";

interface BundleData {
  id: string;
  enabled: boolean;
  should_force_update: boolean;
  message?: string | null;
  target_app_version: string;
  platform: string;
  channel?: string;
}

export const getUpdateInfo = async (
  db: Firestore,
  {
    platform,
    appVersion,
    bundleId,
    channel = "production",
  }: {
    platform: Platform;
    appVersion: string;
    bundleId: string;
    channel?: string;
  },
): Promise<UpdateInfo | null> => {
  try {
    // 1. 번들 컬렉션 쿼리
    const bundlesCollection = db.collection("bundles");
    const bundlesSnapshot = await bundlesCollection
      .where("platform", "==", platform)
      .where("enabled", "==", true)
      .get();

    if (bundlesSnapshot.empty) {
      return createRollbackInfo(bundleId);
    }

    // 2. 번들 데이터 가공 및 호환성 확인
    const bundles: BundleData[] = [];

    for (const doc of bundlesSnapshot.docs) {
      const data = doc.data() as BundleData;

      // 채널 필터링 (채널이 지정된 경우)
      if (channel && data.channel && data.channel !== channel) {
        continue;
      }

      // 호환성 확인
      if (
        data.target_app_version &&
        filterCompatibleAppVersions([data.target_app_version], appVersion)
          .length > 0
      ) {
        bundles.push(data);
      }
    }

    if (bundles.length === 0) {
      return createRollbackInfo(bundleId);
    }

    // 3. ID 기준 내림차순 정렬 (최신 번들)
    bundles.sort((a, b) => b.id.localeCompare(a.id));
    const updateCandidate = bundles[0];

    // 4. 현재 번들과 비교하여 업데이트 필요성 결정
    if (
      bundleId === NIL_UUID ||
      updateCandidate.id.localeCompare(bundleId) > 0
    ) {
      return {
        id: updateCandidate.id,
        shouldForceUpdate: Boolean(updateCandidate.should_force_update),
        message: updateCandidate.message || null,
        status: "UPDATE" as UpdateStatus,
      };
    }

    // 5. 현재 번들의 유효성 확인
    const currentBundleDoc = await bundlesCollection.doc(bundleId).get();

    if (!currentBundleDoc.exists || !currentBundleDoc.data()?.enabled) {
      return {
        id: updateCandidate.id,
        shouldForceUpdate: true,
        message: updateCandidate.message || null,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

    // 업데이트 필요 없음
    return null;
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};

// 롤백 정보 생성 유틸리티 함수
function createRollbackInfo(bundleId: string): UpdateInfo | null {
  if (bundleId === NIL_UUID) {
    return null;
  }

  return {
    id: NIL_UUID,
    shouldForceUpdate: true,
    message: null,
    status: "ROLLBACK" as UpdateStatus,
  };
}
