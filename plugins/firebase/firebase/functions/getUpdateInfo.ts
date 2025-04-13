import type {
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
  UpdateStatus,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { Firestore } from "firebase-admin/firestore";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  id: NIL_UUID,
  shouldForceUpdate: true,
  message: null,
  status: "ROLLBACK",
};

const convertToBundle = (data: any): Bundle => ({
  id: data.id,
  enabled: Boolean(data.enabled),
  shouldForceUpdate: Boolean(data.should_force_update),
  message: data.message || null,
  targetAppVersion: data.target_app_version,
  platform: data.platform,
  channel: data.channel || "production",
  fileHash: data.file_hash || "",
  gitCommitHash: data.git_commit_hash || "",
});

const makeResponse = (bundle: Bundle, status: UpdateStatus): UpdateInfo => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
});

export const getUpdateInfo = async (
  db: Firestore,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  try {
    let currentBundle: Bundle | null = null;
    if (bundleId !== NIL_UUID) {
      const doc = await db.collection("bundles").doc(bundleId).get();
      if (doc.exists) {
        const data = doc.data()!;
        if ((data.channel || "production") !== channel) {
          return null;
        }
        currentBundle = convertToBundle(data);
      }
    }

    if (bundleId.localeCompare(minBundleId) < 0) {
      return null;
    }

    const baseQuery = db
      .collection("bundles")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .where("enabled", "==", true)
      .where("id", ">=", minBundleId);

    let updateCandidate: Bundle | null = null;
    let rollbackCandidate: Bundle | null = null;

    if (bundleId === NIL_UUID) {
      const snap = await baseQuery.orderBy("id", "desc").limit(1).get();
      if (!snap.empty) {
        const data = snap.docs[0].data();
        if (
          filterCompatibleAppVersions([data.target_app_version], appVersion)
            .length > 0
        ) {
          updateCandidate = convertToBundle(data);
        }
      }
    } else {
      const updateSnap = await baseQuery
        .where("id", ">=", bundleId)
        .orderBy("id", "desc")
        .limit(1)
        .get();
      if (!updateSnap.empty) {
        const data = updateSnap.docs[0].data();
        if (
          filterCompatibleAppVersions([data.target_app_version], appVersion)
            .length > 0
        ) {
          updateCandidate = convertToBundle(data);
        }
      }

      const rollbackSnap = await baseQuery
        .where("id", "<", bundleId)
        .orderBy("id", "desc")
        .limit(1)
        .get();
      if (!rollbackSnap.empty) {
        const data = rollbackSnap.docs[0].data();
        if (
          filterCompatibleAppVersions([data.target_app_version], appVersion)
            .length > 0
        ) {
          rollbackCandidate = convertToBundle(data);
        }
      }
    }

    if (bundleId === NIL_UUID) {
      return updateCandidate ? makeResponse(updateCandidate, "UPDATE") : null;
    }
    if (updateCandidate && updateCandidate.id !== bundleId) {
      return makeResponse(updateCandidate, "UPDATE");
    }

    if (updateCandidate && updateCandidate.id === bundleId) {
      if (currentBundle?.enabled) {
        return null;
      }
      return rollbackCandidate
        ? makeResponse(rollbackCandidate, "ROLLBACK")
        : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    if (!updateCandidate) {
      if (rollbackCandidate) {
        return makeResponse(rollbackCandidate, "ROLLBACK");
      }
      return bundleId === minBundleId ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }
    return null;
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};
