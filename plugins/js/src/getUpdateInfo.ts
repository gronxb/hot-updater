import {
  type AppVersionGetBundlesArgs,
  type LegacyBundle,
  type FingerprintGetBundlesArgs,
  type GetBundlesArgs,
  isCohortEligibleForUpdate,
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

const makeResponse = (bundle: LegacyBundle, status: UpdateStatus) => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
  storageUri: bundle.storageUri,
  fileHash: bundle.fileHash,
});

const isEligibleUpdateCandidate = (
  bundle: LegacyBundle,
  cohort: string | undefined,
): boolean => {
  return isCohortEligibleForUpdate(
    bundle.id,
    cohort,
    bundle.rolloutCohortCount,
    bundle.targetCohorts,
  );
};

const findLatestEligibleUpdateCandidate = (
  bundles: LegacyBundle[],
  bundleId: string,
  cohort: string | undefined,
): LegacyBundle | null => {
  let updateCandidate: LegacyBundle | null = null;

  for (const bundle of bundles) {
    if (
      bundle.id.localeCompare(bundleId) > 0 &&
      isEligibleUpdateCandidate(bundle, cohort) &&
      (!updateCandidate || bundle.id.localeCompare(updateCandidate.id) > 0)
    ) {
      updateCandidate = bundle;
    }
  }

  return updateCandidate;
};

export const getUpdateInfo = async (
  bundles: LegacyBundle[],
  args: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  if (bundles.length === 0) return null;
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
  bundles: LegacyBundle[],
  {
    channel = "production",
    minBundleId = NIL_UUID,
    platform,
    appVersion,
    bundleId,
    cohort,
  }: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  // Initial filtering: apply platform, channel, semver conditions, enabled status, and minBundleId condition
  const candidateBundles: LegacyBundle[] = [];

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
  let rollbackCandidate: LegacyBundle | null = null;
  let currentBundle: LegacyBundle | undefined;

  for (const b of candidateBundles) {
    // Check if current bundle exists
    if (b.id === bundleId) {
      currentBundle = b;
    } else if (bundleId !== NIL_UUID && b.id.localeCompare(bundleId) < 0) {
      // Rollback candidate: largest ID among those smaller than the current bundle
      if (!rollbackCandidate || b.id.localeCompare(rollbackCandidate.id) > 0) {
        rollbackCandidate = b;
      }
    }
  }

  const updateCandidate = findLatestEligibleUpdateCandidate(
    candidateBundles,
    bundleId,
    cohort,
  );
  const currentBundleEligible = currentBundle
    ? isEligibleUpdateCandidate(currentBundle, cohort)
    : false;

  if (bundleId === NIL_UUID) {
    if (updateCandidate) {
      return makeResponse(updateCandidate, "UPDATE");
    }
    return null;
  }

  if (currentBundleEligible) {
    if (updateCandidate) {
      return makeResponse(updateCandidate, "UPDATE");
    }
    return null;
  }

  if (updateCandidate) {
    return makeResponse(updateCandidate, "UPDATE");
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
  bundles: LegacyBundle[],
  {
    channel = "production",
    minBundleId = NIL_UUID,
    platform,
    fingerprintHash,
    bundleId,
    cohort,
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const candidateBundles: LegacyBundle[] = [];

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
  let rollbackCandidate: LegacyBundle | null = null;
  let currentBundle: LegacyBundle | undefined;

  for (const b of candidateBundles) {
    // Check if current bundle exists
    if (b.id === bundleId) {
      currentBundle = b;
    } else if (bundleId !== NIL_UUID && b.id.localeCompare(bundleId) < 0) {
      // Rollback candidate: largest ID among those smaller than the current bundle
      if (!rollbackCandidate || b.id.localeCompare(rollbackCandidate.id) > 0) {
        rollbackCandidate = b;
      }
    }
  }

  const updateCandidate = findLatestEligibleUpdateCandidate(
    candidateBundles,
    bundleId,
    cohort,
  );
  const currentBundleEligible = currentBundle
    ? isEligibleUpdateCandidate(currentBundle, cohort)
    : false;

  if (bundleId === NIL_UUID) {
    if (updateCandidate) {
      return makeResponse(updateCandidate, "UPDATE");
    }
    return null;
  }

  if (currentBundleEligible) {
    if (updateCandidate) {
      return makeResponse(updateCandidate, "UPDATE");
    }
    return null;
  }

  if (updateCandidate) {
    return makeResponse(updateCandidate, "UPDATE");
  }
  if (rollbackCandidate) {
    return makeResponse(rollbackCandidate, "ROLLBACK");
  }

  if (minBundleId && bundleId.localeCompare(minBundleId) <= 0) {
    return null;
  }
  return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
};
