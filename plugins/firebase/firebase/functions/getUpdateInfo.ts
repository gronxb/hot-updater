import {
  NIL_UUID,
  type Platform,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { Firestore } from "firebase-admin/firestore";

export const getUpdateInfo = async (
  db: Firestore,
  {
    platform,
    appVersion,
    bundleId,
  }: {
    platform: Platform;
    appVersion: string;
    bundleId: string;
  },
): Promise<UpdateInfo | null> => {
  try {
    const appVersionsSnapshot = await db
      .collection("bundles")
      .where("platform", "==", platform)
      .get();

    if (appVersionsSnapshot.empty) {
      if (bundleId !== NIL_UUID) {
        return {
          id: NIL_UUID,
          shouldForceUpdate: true,
          fileUrl: null,
          fileHash: null,
          status: "ROLLBACK" as UpdateStatus,
        };
      }
      return null;
    }

    const appVersionList = appVersionsSnapshot.docs.map(
      (doc) => doc.data().target_app_version,
    );
    const uniqueAppVersions = [...new Set(appVersionList)];

    const targetAppVersionList = filterCompatibleAppVersions(
      uniqueAppVersions,
      appVersion,
    );

    if (targetAppVersionList.length === 0) {
      return null;
    }

    const enabledBundlesSnapshot = await db
      .collection("bundles")
      .where("enabled", "==", true)
      .where("platform", "==", platform)
      .where("target_app_version", "in", targetAppVersionList)
      .get();

    if (enabledBundlesSnapshot.empty) {
      if (bundleId !== NIL_UUID) {
        return {
          id: NIL_UUID,
          shouldForceUpdate: true,
          fileUrl: null,
          fileHash: null,
          status: "ROLLBACK" as UpdateStatus,
        };
      }
      return null;
    }

    const bundles = enabledBundlesSnapshot.docs
      .map((doc) => doc.data())
      .sort((a, b) => b.id.localeCompare(a.id));

    const updateCandidate = bundles[0];

    if (
      bundleId === NIL_UUID ||
      updateCandidate.id.localeCompare(bundleId) > 0
    ) {
      return {
        id: updateCandidate.id,
        shouldForceUpdate: Boolean(updateCandidate.should_force_update),
        fileUrl: updateCandidate.file_url,
        fileHash: updateCandidate.file_hash,
        status: "UPDATE" as UpdateStatus,
      };
    }

    if (bundleId !== NIL_UUID) {
      const currentBundleDoc = await db
        .collection("bundles")
        .doc(bundleId)
        .get();

      if (!currentBundleDoc.exists || !currentBundleDoc.data()?.enabled) {
        if (bundles.length > 0) {
          const rollbackCandidate = bundles[0];
          return {
            id: rollbackCandidate.id,
            shouldForceUpdate: true,
            fileUrl: rollbackCandidate.file_url,
            fileHash: rollbackCandidate.file_hash,
            status: "ROLLBACK" as UpdateStatus,
          };
        }

        return {
          id: NIL_UUID,
          shouldForceUpdate: true,
          fileUrl: null,
          fileHash: null,
          status: "ROLLBACK" as UpdateStatus,
        };
      }
    }

    return null;
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};
