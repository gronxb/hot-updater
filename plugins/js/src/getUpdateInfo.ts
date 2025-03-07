import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { semverSatisfies } from "./semverSatisfies";

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  message: null,
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

  const candidateBundles = minBundleId
    ? enabledBundles.filter((b) => b.id.localeCompare(minBundleId) >= 0)
    : enabledBundles;

  if (candidateBundles.length === 0) {
    if (enabledBundles.length === 0) {
      return bundleId === NIL_UUID ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }
    if (minBundleId && bundleId === minBundleId) {
      return null;
    }
    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  }

  // 5. 후보 번들을 한 번만 내림차순 정렬 (최신 순)
  const sortedCandidates = candidateBundles
    .slice()
    .sort((a, b) => b.id.localeCompare(a.id));
  const latestCandidate = sortedCandidates[0];

  const makeResponse = (bundle: Bundle, status: UpdateStatus) => ({
    id: bundle.id,
    fileUrl: bundle.fileUrl,
    message: bundle.message,
    shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
    status,
  });

  if (bundleId === NIL_UUID) {
    if (latestCandidate && latestCandidate.id.localeCompare(bundleId) > 0) {
      return makeResponse(latestCandidate, "UPDATE");
    }
    return null;
  }

  const currentBundle = candidateBundles.find((b) => b.id === bundleId);
  if (currentBundle) {
    if (latestCandidate.id.localeCompare(currentBundle.id) > 0) {
      return makeResponse(latestCandidate, "UPDATE");
    }
    return null;
  }

  let updateCandidate: Bundle | null = null;
  let rollbackCandidate: Bundle | null = null;
  for (const b of sortedCandidates) {
    if (!updateCandidate && b.id.localeCompare(bundleId) > 0) {
      updateCandidate = b;
    }
    if (!rollbackCandidate && b.id.localeCompare(bundleId) < 0) {
      rollbackCandidate = b;
    }
    if (updateCandidate && rollbackCandidate) break;
  }

  if (updateCandidate) {
    return makeResponse(updateCandidate, "UPDATE");
  }
  if (rollbackCandidate) {
    return makeResponse(rollbackCandidate, "ROLLBACK");
  }

  if (minBundleId && bundleId === minBundleId) {
    return null;
  }
  return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
};
