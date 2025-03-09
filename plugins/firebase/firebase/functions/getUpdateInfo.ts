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
    const snapshot = await db
      .collection("bundles")
      .where("platform", "==", platform)
      .where("enabled", "==", true)
      .get();

    if (snapshot.empty) {
      return bundleId !== NIL_UUID
        ? {
            id: NIL_UUID,
            shouldForceUpdate: true,
            fileUrl: null,
            fileHash: null,
            status: "ROLLBACK" as UpdateStatus,
          }
        : null;
    }

    const candidates = snapshot.docs
      .map((doc) => doc.data())
      .filter((bundle) => {
        return (
          filterCompatibleAppVersions([bundle.target_app_version], appVersion)
            .length > 0
        );
      });
    if (candidates.length === 0) {
      return bundleId !== NIL_UUID
        ? {
            id: NIL_UUID,
            shouldForceUpdate: true,
            fileUrl: null,
            fileHash: null,
            status: "ROLLBACK" as UpdateStatus,
          }
        : null;
    }

    candidates.sort((a, b) => b.id.localeCompare(a.id));
    const updateCandidate = candidates[0];

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

    const currentBundleDoc = await db.collection("bundles").doc(bundleId).get();
    if (!currentBundleDoc.exists || !currentBundleDoc.data()?.enabled) {
      return {
        id: updateCandidate.id,
        shouldForceUpdate: true,
        fileUrl: updateCandidate.file_url,
        fileHash: updateCandidate.file_hash,
        status: "ROLLBACK" as UpdateStatus,
      };
    }
    return null;
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};
