import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { semverSatisfies } from "./semverSatisfies";

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  fileHash: null,
  fileUrl: null,
  id: NIL_UUID,
  shouldForceUpdate: true,
  status: "ROLLBACK",
};

export const getUpdateInfo = async (
  bundles: Bundle[],
  { platform, bundleId, appVersion, minBundleId }: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const filteredBundles = bundles.filter(
    (b) =>
      b.platform === platform &&
      semverSatisfies(b.targetAppVersion, appVersion),
  );
  const enabledBundles = filteredBundles.filter((b) => b.enabled);

  let candidateBundles = enabledBundles;
  if (minBundleId) {
    candidateBundles = enabledBundles.filter(
      (b) => b.id.localeCompare(minBundleId) >= 0,
    );
  }

  const getLatest = (arr: Bundle[]): Bundle | null => {
    if (arr.length === 0) return null;
    return [...arr].sort((a, b) => b.id.localeCompare(a.id))[0];
  };

  if (bundleId === NIL_UUID) {
    const latestCandidate = getLatest(candidateBundles);
    if (latestCandidate && latestCandidate.id.localeCompare(bundleId) > 0) {
      return {
        id: latestCandidate.id,
        fileUrl: latestCandidate.fileUrl,
        fileHash: latestCandidate.fileHash,
        shouldForceUpdate: latestCandidate.shouldForceUpdate,
        status: "UPDATE" as UpdateStatus,
      };
    }
    return null;
  }

  const currentBundle = candidateBundles.find((b) => b.id === bundleId);

  if (currentBundle) {
    const latestCandidate = getLatest(candidateBundles);
    if (
      latestCandidate &&
      latestCandidate.id.localeCompare(currentBundle.id) > 0
    ) {
      return {
        id: latestCandidate.id,
        fileUrl: latestCandidate.fileUrl,
        fileHash: latestCandidate.fileHash,
        shouldForceUpdate: latestCandidate.shouldForceUpdate,
        status: "UPDATE" as UpdateStatus,
      };
    }
    return null;
  }
  const updateCandidate = candidateBundles
    .filter((b) => b.id.localeCompare(bundleId) > 0)
    .sort((a, b) => b.id.localeCompare(a.id))[0];
  if (updateCandidate) {
    return {
      id: updateCandidate.id,
      fileUrl: updateCandidate.fileUrl,
      fileHash: updateCandidate.fileHash,
      shouldForceUpdate: updateCandidate.shouldForceUpdate,
      status: "UPDATE" as UpdateStatus,
    };
  }
  const rollbackCandidate = candidateBundles
    .filter((b) => b.id.localeCompare(bundleId) < 0)
    .sort((a, b) => b.id.localeCompare(a.id))[0];
  if (rollbackCandidate) {
    return {
      id: rollbackCandidate.id,
      fileUrl: rollbackCandidate.fileUrl,
      fileHash: rollbackCandidate.fileHash,
      // 롤백의 경우 강제로 업데이트하도록 처리
      shouldForceUpdate: true,
      status: "ROLLBACK" as UpdateStatus,
    };
  }
  if (enabledBundles.length === 0) {
    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  }
  if (minBundleId && bundleId === minBundleId) {
    return null;
  }
  return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
};
