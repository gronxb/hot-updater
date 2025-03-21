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
    const bundlesCollection = db.collection("bundles");
    const bundlesSnapshot = await bundlesCollection
      .where("platform", "==", platform)
      .where("enabled", "==", true)
      .get();

    if (bundlesSnapshot.empty) {
      return createRollbackInfo(bundleId);
    }

    const bundles: BundleData[] = [];

    for (const doc of bundlesSnapshot.docs) {
      const data = doc.data() as BundleData;

      if (channel && data.channel && data.channel !== channel) {
        continue;
      }

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

    bundles.sort((a, b) => b.id.localeCompare(a.id));
    const updateCandidate = bundles[0];

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

    const currentBundleDoc = await bundlesCollection.doc(bundleId).get();

    if (!currentBundleDoc.exists || !currentBundleDoc.data()?.enabled) {
      return {
        id: updateCandidate.id,
        shouldForceUpdate: true,
        message: updateCandidate.message || null,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

    return null;
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};

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
