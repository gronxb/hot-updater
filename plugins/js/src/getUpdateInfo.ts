import {
  type AppVersionGetBundlesArgs,
  type Bundle,
  type GetBundlesArgs,
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
};

const makeResponse = (bundle: Bundle, status: UpdateStatus) => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
});

export const getUpdateInfo = async (
  bundles: Bundle[],
  args: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  if (args._updateStrategy === "appVersion") {
    return getUpdateInfoStrategyAppVersion(bundles, args);
  }

  // TODO: Implement fingerprint strategy
  // return getUpdateInfoStrategyFingerprint(bundles, args);
  return null;
};

export const getUpdateInfoStrategyAppVersion = async (
  bundles: Bundle[],
  args: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  // Initial filtering: apply platform, channel, semver conditions, enabled status, and minBundleId condition
  const candidateBundles: Bundle[] = [];

  for (const b of bundles) {
    if (
      b.platform !== args.platform ||
      b.channel !== args.channel ||
      !b.targetAppVersion ||
      !semverSatisfies(b.targetAppVersion, args.appVersion) ||
      !b.enabled ||
      (args.minBundleId && b.id.localeCompare(args.minBundleId) < 0)
    ) {
      continue;
    }
    candidateBundles.push(b);
  }

  if (candidateBundles.length === 0) {
    if (
      args.bundleId === NIL_UUID ||
      (args.minBundleId && args.bundleId.localeCompare(args.minBundleId) <= 0)
    ) {
      return null;
    }
    return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  }

  // Determine the latest bundle, update candidate, rollback candidate, and current bundle in a single iteration
  let latestCandidate: Bundle | null = null;
  let updateCandidate: Bundle | null = null;
  let rollbackCandidate: Bundle | null = null;
  let currentBundle: Bundle | undefined = undefined;

  for (const b of candidateBundles) {
    // Latest bundle (bundle with the largest ID)
    if (!latestCandidate || b.id.localeCompare(latestCandidate.id) > 0) {
      latestCandidate = b;
    }
    // Check if current bundle exists
    if (b.id === args.bundleId) {
      currentBundle = b;
    } else if (args.bundleId !== NIL_UUID) {
      // Update candidate: largest ID among those greater than the current bundle
      if (b.id.localeCompare(args.bundleId) > 0) {
        if (!updateCandidate || b.id.localeCompare(updateCandidate.id) > 0) {
          updateCandidate = b;
        }
      }
      // Rollback candidate: largest ID among those smaller than the current bundle
      else if (b.id.localeCompare(args.bundleId) < 0) {
        if (
          !rollbackCandidate ||
          b.id.localeCompare(rollbackCandidate.id) > 0
        ) {
          rollbackCandidate = b;
        }
      }
    }
  }

  if (args.bundleId === NIL_UUID) {
    // For NIL_UUID, return an update if there's a latest candidate
    if (
      latestCandidate &&
      latestCandidate.id.localeCompare(args.bundleId) > 0
    ) {
      return makeResponse(latestCandidate, "UPDATE");
    }
    return null;
  }

  if (currentBundle) {
    // If current bundle exists, compare with latest candidate to determine update
    if (
      latestCandidate &&
      latestCandidate.id.localeCompare(currentBundle.id) > 0
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

  if (args.minBundleId && args.bundleId.localeCompare(args.minBundleId) <= 0) {
    return null;
  }
  return INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
};
