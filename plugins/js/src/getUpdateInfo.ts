import {
  type AppVersionGetBundlesArgs,
  type Bundle,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  maskUuidV7Rand,
  NIL_UUID,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { semverSatisfies } from "./semverSatisfies";

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
  }: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const maskedBundleId = maskUuidV7Rand(bundleId);

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
      (minBundleId && maskedBundleId.localeCompare(minBundleId) <= 0)
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
    const maskedId = maskUuidV7Rand(b.id);
    // Latest bundle (bundle with the largest ID)
    if (!latestCandidate || b.id.localeCompare(latestCandidate.id) > 0) {
      latestCandidate = b;
    }
    // Check if current bundle exists (same UUIDv7 timestamp = same version)
    if (maskedId === maskedBundleId) {
      currentBundle = b;
    } else if (bundleId !== NIL_UUID) {
      // Update candidate: largest ID among those with a later timestamp
      if (maskedId.localeCompare(maskedBundleId) > 0) {
        if (!updateCandidate || b.id.localeCompare(updateCandidate.id) > 0) {
          updateCandidate = b;
        }
      }
      // Rollback candidate: largest ID among those with an earlier timestamp
      else if (maskedId.localeCompare(maskedBundleId) < 0) {
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
      return makeResponse(latestCandidate, "UPDATE");
    }
    return null;
  }

  if (currentBundle) {
    // If current bundle exists, compare with latest candidate to determine update
    if (
      latestCandidate &&
      maskUuidV7Rand(latestCandidate.id).localeCompare(maskedBundleId) > 0
    ) {
      return makeResponse(latestCandidate, "UPDATE");
    }
    return null;
  }

  // If current bundle doesn't exist, prioritize update candidate, then rollback candidate
  if (updateCandidate) {
    return makeResponse(updateCandidate, "UPDATE");
  }
  if (rollbackCandidate) {
    return makeResponse(rollbackCandidate, "ROLLBACK");
  }

  if (minBundleId && maskedBundleId.localeCompare(minBundleId) <= 0) {
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
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const maskedBundleId = maskUuidV7Rand(bundleId);
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
      (minBundleId && maskedBundleId.localeCompare(minBundleId) <= 0)
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
    const maskedId = maskUuidV7Rand(b.id);
    // Latest bundle (bundle with the largest ID)
    if (!latestCandidate || b.id.localeCompare(latestCandidate.id) > 0) {
      latestCandidate = b;
    }
    // Check if current bundle exists (same UUIDv7 timestamp = same version)
    if (maskedId === maskedBundleId) {
      currentBundle = b;
    } else if (bundleId !== NIL_UUID) {
      // Update candidate: largest ID among those with a later timestamp
      if (maskedId.localeCompare(maskedBundleId) > 0) {
        if (!updateCandidate || b.id.localeCompare(updateCandidate.id) > 0) {
          updateCandidate = b;
        }
      }
      // Rollback candidate: largest ID among those with an earlier timestamp
      else if (maskedId.localeCompare(maskedBundleId) < 0) {
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
      return makeResponse(latestCandidate, "UPDATE");
    }
    return null;
  }

  if (currentBundle) {
    // If current bundle exists, compare with latest candidate to determine update
    if (
      latestCandidate &&
      maskUuidV7Rand(latestCandidate.id).localeCompare(maskedBundleId) > 0
    ) {
      return makeResponse(latestCandidate, "UPDATE");
    }
    return null;
  }

  // If current bundle doesn't exist, prioritize update candidate, then rollback candidate
  if (updateCandidate) {
    return makeResponse(updateCandidate, "UPDATE");
  }
  if (rollbackCandidate) {
    return makeResponse(rollbackCandidate, "ROLLBACK");
  }

  if (minBundleId && maskedBundleId.localeCompare(minBundleId) <= 0) {
    return null;
  }
  return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
};
