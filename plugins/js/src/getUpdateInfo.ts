import {
  type AppVersionGetBundlesArgs,
  type Bundle,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { semverSatisfies } from "./semverSatisfies";

function hashUserId(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash % 100);
}

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  message: null,
  id: NIL_UUID,
  shouldForceUpdate: true,
  status: "ROLLBACK",
  storageUri: null,
  fileHash: null,
};

const makeResponse = (bundle: Bundle, status: UpdateStatus) => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
  storageUri: bundle.storageUri,
  fileHash: bundle.fileHash,
});

const makeResponseWithRollout = (
  bundle: Bundle,
  status: UpdateStatus,
  deviceId: string | undefined,
): UpdateInfo | null => {
  if (status === "UPDATE" && deviceId) {
    // Inline eligibility check
    const targetDeviceIds = bundle.targetDeviceIds;
    const rolloutPercentage = bundle.rolloutPercentage;

    // Priority 1: targetDeviceIds
    if (targetDeviceIds && targetDeviceIds.length > 0) {
      if (!targetDeviceIds.includes(deviceId)) {
        return null;
      }
    } else {
      // Priority 2: rolloutPercentage
      if (
        rolloutPercentage !== null &&
        rolloutPercentage !== undefined &&
        rolloutPercentage < 100
      ) {
        if (rolloutPercentage <= 0) {
          return null;
        }

        const userHash = hashUserId(deviceId);
        if (userHash >= rolloutPercentage) {
          return null;
        }
      }
    }
  }

  return makeResponse(bundle, status);
};

export const getUpdateInfo = async (
  bundles: Bundle[],
  args: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  switch (args._updateStrategy) {
    case "appVersion":
      return appVersionStrategy(bundles, args);
    case "fingerprint":
      return fingerprintStrategy(bundles, args);
    default:
      return null;
  }
};

const appVersionStrategy = async (
  bundles: Bundle[],
  {
    channel = "production",
    minBundleId = NIL_UUID,
    platform,
    appVersion,
    bundleId,
    deviceId,
  }: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  // Initial filtering: apply platform, channel, semver conditions, enabled status, and minBundleId condition
  const candidateBundles: Bundle[] = [];

  for (const b of bundles) {
    if (
      b.platform !== platform ||
      b.channel !== channel ||
      !b.targetAppVersion ||
      !semverSatisfies(b.targetAppVersion, appVersion) ||
      !b.enabled ||
      (minBundleId && b.id.localeCompare(minBundleId) < 0)
    ) {
      continue;
    }
    candidateBundles.push(b);
  }

  if (candidateBundles.length === 0) {
    if (
      bundleId === NIL_UUID ||
      (minBundleId && bundleId.localeCompare(minBundleId) <= 0)
    ) {
      return null;
    }
    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  }

  // Determine the latest bundle, update candidate, rollback candidate, and current bundle in a single iteration
  let latestCandidate: Bundle | null = null;
  let updateCandidate: Bundle | null = null;
  let rollbackCandidate: Bundle | null = null;
  let currentBundle: Bundle | undefined;

  for (const b of candidateBundles) {
    // Latest bundle (bundle with the largest ID)
    if (!latestCandidate || b.id.localeCompare(latestCandidate.id) > 0) {
      latestCandidate = b;
    }
    // Check if current bundle exists
    if (b.id === bundleId) {
      currentBundle = b;
    } else if (bundleId !== NIL_UUID) {
      // Update candidate: largest ID among those greater than the current bundle
      if (b.id.localeCompare(bundleId) > 0) {
        if (!updateCandidate || b.id.localeCompare(updateCandidate.id) > 0) {
          updateCandidate = b;
        }
      }
      // Rollback candidate: largest ID among those smaller than the current bundle
      else if (b.id.localeCompare(bundleId) < 0) {
        if (
          !rollbackCandidate ||
          b.id.localeCompare(rollbackCandidate.id) > 0
        ) {
          rollbackCandidate = b;
        }
      }
    }
  }

  if (bundleId === NIL_UUID) {
    // For NIL_UUID, return an update if there's a latest candidate
    if (latestCandidate && latestCandidate.id.localeCompare(bundleId) > 0) {
      return makeResponseWithRollout(latestCandidate, "UPDATE", deviceId);
    }
    return null;
  }

  if (currentBundle) {
    // If current bundle exists, compare with latest candidate to determine update
    if (
      latestCandidate &&
      latestCandidate.id.localeCompare(currentBundle.id) > 0
    ) {
      return makeResponseWithRollout(latestCandidate, "UPDATE", deviceId);
    }
    return null;
  }

  // If current bundle doesn't exist, prioritize update candidate, then rollback candidate
  if (updateCandidate) {
    return makeResponseWithRollout(updateCandidate, "UPDATE", deviceId);
  }
  if (rollbackCandidate) {
    return makeResponse(rollbackCandidate, "ROLLBACK");
  }

  if (minBundleId && bundleId.localeCompare(minBundleId) <= 0) {
    return null;
  }
  return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
};

const fingerprintStrategy = async (
  bundles: Bundle[],
  {
    channel = "production",
    minBundleId = NIL_UUID,
    platform,
    fingerprintHash,
    bundleId,
    deviceId,
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const candidateBundles: Bundle[] = [];

  for (const b of bundles) {
    if (
      b.platform !== platform ||
      b.channel !== channel ||
      !b.fingerprintHash ||
      b.fingerprintHash !== fingerprintHash ||
      !b.enabled ||
      (minBundleId && b.id.localeCompare(minBundleId) < 0)
    ) {
      continue;
    }
    candidateBundles.push(b);
  }

  if (candidateBundles.length === 0) {
    if (
      bundleId === NIL_UUID ||
      (minBundleId && bundleId.localeCompare(minBundleId) <= 0)
    ) {
      return null;
    }
    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  }

  // Determine the latest bundle, update candidate, rollback candidate, and current bundle in a single iteration
  let latestCandidate: Bundle | null = null;
  let updateCandidate: Bundle | null = null;
  let rollbackCandidate: Bundle | null = null;
  let currentBundle: Bundle | undefined;

  for (const b of candidateBundles) {
    // Latest bundle (bundle with the largest ID)
    if (!latestCandidate || b.id.localeCompare(latestCandidate.id) > 0) {
      latestCandidate = b;
    }
    // Check if current bundle exists
    if (b.id === bundleId) {
      currentBundle = b;
    } else if (bundleId !== NIL_UUID) {
      // Update candidate: largest ID among those greater than the current bundle
      if (b.id.localeCompare(bundleId) > 0) {
        if (!updateCandidate || b.id.localeCompare(updateCandidate.id) > 0) {
          updateCandidate = b;
        }
      }
      // Rollback candidate: largest ID among those smaller than the current bundle
      else if (b.id.localeCompare(bundleId) < 0) {
        if (
          !rollbackCandidate ||
          b.id.localeCompare(rollbackCandidate.id) > 0
        ) {
          rollbackCandidate = b;
        }
      }
    }
  }

  if (bundleId === NIL_UUID) {
    // For NIL_UUID, return an update if there's a latest candidate
    if (latestCandidate && latestCandidate.id.localeCompare(bundleId) > 0) {
      return makeResponseWithRollout(latestCandidate, "UPDATE", deviceId);
    }
    return null;
  }

  if (currentBundle) {
    // If current bundle exists, compare with latest candidate to determine update
    if (
      latestCandidate &&
      latestCandidate.id.localeCompare(currentBundle.id) > 0
    ) {
      return makeResponseWithRollout(latestCandidate, "UPDATE", deviceId);
    }
    return null;
  }

  // If current bundle doesn't exist, prioritize update candidate, then rollback candidate
  if (updateCandidate) {
    return makeResponseWithRollout(updateCandidate, "UPDATE", deviceId);
  }
  if (rollbackCandidate) {
    return makeResponse(rollbackCandidate, "ROLLBACK");
  }

  if (minBundleId && bundleId.localeCompare(minBundleId) <= 0) {
    return null;
  }
  return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
};
