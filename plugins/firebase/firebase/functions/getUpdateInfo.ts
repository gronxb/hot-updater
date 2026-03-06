import type {
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  UpdateInfo,
  UpdateStatus,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { Firestore } from "firebase-admin/firestore";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash % 100);
}

function isDeviceEligibleForPercentage(
  userId: string,
  rolloutPercentage: number | null | undefined,
): boolean {
  if (
    rolloutPercentage === null ||
    rolloutPercentage === undefined ||
    rolloutPercentage >= 100
  ) {
    return true;
  }

  if (rolloutPercentage <= 0) {
    return false;
  }

  const userHash = hashUserId(userId);
  return userHash < rolloutPercentage;
}

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  id: NIL_UUID,
  shouldForceUpdate: true,
  message: null,
  status: "ROLLBACK",
  storageUri: null,
  fileHash: null,
};

const convertToBundle = (data: any): Bundle => ({
  id: data.id,
  enabled: Boolean(data.enabled),
  shouldForceUpdate: Boolean(data.should_force_update),
  message: data.message || null,
  targetAppVersion: data.target_app_version,
  platform: data.platform,
  channel: data.channel || "production",
  fileHash: data.file_hash,
  gitCommitHash: data.git_commit_hash,
  fingerprintHash: data.fingerprint_hash,
  storageUri: data.storage_uri,
  rolloutPercentage: data.rollout_percentage ?? null,
  targetDeviceIds: data.target_device_ids || null,
});

const makeResponse = (bundle: Bundle, status: UpdateStatus): UpdateInfo => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
  storageUri: bundle.storageUri,
  fileHash: bundle.fileHash,
});

const checkTargetDeviceIdsEligibility = (
  bundle: Bundle,
  deviceId: string | undefined,
): boolean => {
  // If bundle has targetDeviceIds, device must be in the list
  if (bundle.targetDeviceIds && bundle.targetDeviceIds.length > 0) {
    if (!deviceId) {
      return false;
    }
    return bundle.targetDeviceIds.includes(deviceId);
  }
  // No targetDeviceIds restriction - check percentage
  return true;
};

const makeResponseWithRollout = (
  bundle: Bundle,
  status: UpdateStatus,
  deviceId: string | undefined,
): UpdateInfo | null => {
  if (status === "UPDATE") {
    // Check targetDeviceIds eligibility
    if (!checkTargetDeviceIdsEligibility(bundle, deviceId)) {
      return null;
    }

    // If device matched via targetDeviceIds, skip percentage check (priority 1)
    if (
      bundle.targetDeviceIds &&
      bundle.targetDeviceIds.length > 0 &&
      deviceId &&
      bundle.targetDeviceIds.includes(deviceId)
    ) {
      // Device is explicitly targeted - skip percentage check
      return makeResponse(bundle, status);
    }

    // Check percentage-based rollout (priority 2)
    if (deviceId) {
      const isEligible = isDeviceEligibleForPercentage(
        deviceId,
        bundle.rolloutPercentage,
      );

      if (!isEligible) {
        return null;
      }
    }
  }

  return makeResponse(bundle, status);
};

export const getUpdateInfo = async (
  db: Firestore,
  args: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  switch (args._updateStrategy) {
    case "appVersion":
      return appVersionStrategy(db, args);
    case "fingerprint":
      return fingerprintStrategy(db, args);
    default:
      return null;
  }
};

const fingerprintStrategy = async (
  db: Firestore,
  {
    platform,
    fingerprintHash,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    deviceId,
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  try {
    let currentBundle: Bundle | null = null;
    if (bundleId !== NIL_UUID) {
      const doc = await db.collection("bundles").doc(bundleId).get();
      if (doc.exists) {
        const data = doc.data()!;
        if (data.channel !== channel) {
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
      .where("id", ">=", minBundleId)
      .where("fingerprint_hash", "==", fingerprintHash);

    let updateCandidate: Bundle | null = null;
    let rollbackCandidate: Bundle | null = null;

    if (bundleId === NIL_UUID) {
      // Two-stage query for UPDATE candidates when deviceId is provided
      if (deviceId) {
        // Stage 1: Try to find bundle with explicit targetDeviceIds match
        const targetedSnap = await baseQuery
          .where("target_device_ids", "array-contains", deviceId)
          .orderBy("id", "desc")
          .limit(1)
          .get();

        if (!targetedSnap.empty) {
          updateCandidate = convertToBundle(targetedSnap.docs[0].data());
        }
      }

      // Stage 2: If no targeted match, query without array-contains filter
      if (!updateCandidate) {
        const snap = await baseQuery.orderBy("id", "desc").limit(1).get();
        if (!snap.empty) {
          updateCandidate = convertToBundle(snap.docs[0].data());
        }
      }
    } else {
      // UPDATE candidate query
      if (deviceId) {
        // Stage 1: Try with array-contains filter
        const targetedUpdateSnap = await baseQuery
          .where("id", ">=", bundleId)
          .where("target_device_ids", "array-contains", deviceId)
          .orderBy("id", "desc")
          .limit(1)
          .get();

        if (!targetedUpdateSnap.empty) {
          updateCandidate = convertToBundle(targetedUpdateSnap.docs[0].data());
        }
      }

      // Stage 2: If no targeted match, query without array-contains
      if (!updateCandidate) {
        const updateSnap = await baseQuery
          .where("id", ">=", bundleId)
          .orderBy("id", "desc")
          .limit(1)
          .get();
        if (!updateSnap.empty) {
          updateCandidate = convertToBundle(updateSnap.docs[0].data());
        }
      }

      // ROLLBACK candidate query (no array-contains filter for rollbacks)
      const rollbackSnap = await baseQuery
        .where("id", "<", bundleId)
        .orderBy("id", "desc")
        .limit(1)
        .get();
      if (!rollbackSnap.empty) {
        rollbackCandidate = convertToBundle(rollbackSnap.docs[0].data());
      }
    }

    if (bundleId === NIL_UUID) {
      return updateCandidate
        ? makeResponseWithRollout(updateCandidate, "UPDATE", deviceId)
        : null;
    }
    if (updateCandidate && updateCandidate.id !== bundleId) {
      return makeResponseWithRollout(updateCandidate, "UPDATE", deviceId);
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

const appVersionStrategy = async (
  db: Firestore,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
    deviceId,
  }: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  try {
    let currentBundle: Bundle | null = null;
    if (bundleId !== NIL_UUID) {
      const doc = await db.collection("bundles").doc(bundleId).get();
      if (doc.exists) {
        const data = doc.data()!;
        if (data.channel !== channel) {
          return null;
        }
        currentBundle = convertToBundle(data);
      }
    }

    if (bundleId.localeCompare(minBundleId) < 0) {
      return null;
    }

    const appVersionsSnapshot = await db
      .collection("target_app_versions")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .select("target_app_version")
      .get();

    const appVersions = Array.from(
      new Set(
        appVersionsSnapshot.docs.map(
          (doc) => doc.data().target_app_version as string,
        ),
      ),
    );

    const targetAppVersionList = filterCompatibleAppVersions(
      appVersions,
      appVersion,
    );

    if (targetAppVersionList.length === 0) {
      return bundleId === minBundleId ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    const baseQuery = db
      .collection("bundles")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .where("enabled", "==", true)
      .where("id", ">=", minBundleId)
      .where("target_app_version", "in", targetAppVersionList);

    let updateCandidate: Bundle | null = null;
    let rollbackCandidate: Bundle | null = null;

    if (bundleId === NIL_UUID) {
      // Two-stage query for UPDATE candidates when deviceId is provided
      if (deviceId) {
        // Stage 1: Try to find bundle with explicit targetDeviceIds match
        const targetedSnap = await baseQuery
          .where("target_device_ids", "array-contains", deviceId)
          .orderBy("id", "desc")
          .limit(1)
          .get();

        if (!targetedSnap.empty) {
          updateCandidate = convertToBundle(targetedSnap.docs[0].data());
        }
      }

      // Stage 2: If no targeted match, query without array-contains filter
      if (!updateCandidate) {
        const snap = await baseQuery.orderBy("id", "desc").limit(1).get();
        if (!snap.empty) {
          updateCandidate = convertToBundle(snap.docs[0].data());
        }
      }
    } else {
      // UPDATE candidate query
      if (deviceId) {
        // Stage 1: Try with array-contains filter
        const targetedUpdateSnap = await baseQuery
          .where("id", ">=", bundleId)
          .where("target_device_ids", "array-contains", deviceId)
          .orderBy("id", "desc")
          .limit(1)
          .get();

        if (!targetedUpdateSnap.empty) {
          updateCandidate = convertToBundle(targetedUpdateSnap.docs[0].data());
        }
      }

      // Stage 2: If no targeted match, query without array-contains
      if (!updateCandidate) {
        const updateSnap = await baseQuery
          .where("id", ">=", bundleId)
          .orderBy("id", "desc")
          .limit(1)
          .get();
        if (!updateSnap.empty) {
          updateCandidate = convertToBundle(updateSnap.docs[0].data());
        }
      }

      // ROLLBACK candidate query (no array-contains filter for rollbacks)
      const rollbackSnap = await baseQuery
        .where("id", "<", bundleId)
        .orderBy("id", "desc")
        .limit(1)
        .get();
      if (!rollbackSnap.empty) {
        rollbackCandidate = convertToBundle(rollbackSnap.docs[0].data());
      }
    }

    if (bundleId === NIL_UUID) {
      return updateCandidate
        ? makeResponseWithRollout(updateCandidate, "UPDATE", deviceId)
        : null;
    }
    if (updateCandidate && updateCandidate.id !== bundleId) {
      return makeResponseWithRollout(updateCandidate, "UPDATE", deviceId);
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
