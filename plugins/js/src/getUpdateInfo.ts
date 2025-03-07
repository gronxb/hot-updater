import {
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
  type UpdateStatus,
} from "@hot-updater/core";
import { checkForRollback } from "./checkForRollback";
import { semverSatisfies } from "./semverSatisfies";

const findLatestBundles = (bundles: Bundle[]) => {
  return (
    bundles
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.id.localeCompare(a.id))?.[0] ?? null
  );
};

export const getUpdateInfo = async (
  bundles: Bundle[],
  { platform, bundleId, appVersion }: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  const filteredBundles = bundles.filter(
    (b) =>
      b.platform === platform &&
      semverSatisfies(b.targetAppVersion, appVersion),
  );

  const latestBundle = await findLatestBundles(filteredBundles);

  // Special handling for build-time generated bundle IDs:
  const isBuildTime =
    bundleId !== NIL_UUID && bundleId.endsWith("7000-8000-000000000000");
  if (isBuildTime) {
    // Get the prefix (everything except the last segment)
    const buildTimePrefix = bundleId.slice(0, bundleId.lastIndexOf("-"));
    if (!latestBundle) {
      return null;
    }
    const latestPrefix = latestBundle.id.slice(
      0,
      latestBundle.id.lastIndexOf("-"),
    );
    // If the available bundle is from the same build time, it's not a valid update.
    if (latestPrefix === buildTimePrefix) {
      return null;
    }
    // Only if the available bundle has a prefix greater than the build-time prefix,
    // consider it a valid update.
    if (latestPrefix.localeCompare(buildTimePrefix) > 0) {
      return {
        id: latestBundle.id,
        shouldForceUpdate: Boolean(latestBundle.shouldForceUpdate),
        fileUrl: latestBundle.fileUrl,
        fileHash: latestBundle.fileHash,
        status: "UPDATE" as UpdateStatus,
      };
    }
    return null;
  }

  // Standard rollback/update logic for non-build-time bundle IDs.
  const isRollback = checkForRollback(filteredBundles, bundleId);

  if (!latestBundle) {
    if (isRollback) {
      return {
        id: NIL_UUID,
        shouldForceUpdate: true,
        fileUrl: null,
        fileHash: null,
        status: "ROLLBACK" as UpdateStatus,
      };
    }
    return null;
  }

  if (latestBundle.fileUrl)
    if (isRollback) {
      if (latestBundle.id === bundleId) {
        return null;
      }
      if (latestBundle.id.localeCompare(bundleId) > 0) {
        return {
          id: latestBundle.id,
          shouldForceUpdate: Boolean(latestBundle.shouldForceUpdate),
          fileUrl: latestBundle.fileUrl,
          fileHash: latestBundle.fileHash,
          status: "UPDATE" as UpdateStatus,
        };
      }
      return {
        id: latestBundle.id,
        shouldForceUpdate: true,
        fileUrl: latestBundle.fileUrl,
        fileHash: latestBundle.fileHash,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

  if (latestBundle.id.localeCompare(bundleId) > 0) {
    return {
      id: latestBundle.id,
      shouldForceUpdate: Boolean(latestBundle.shouldForceUpdate),
      fileUrl: latestBundle.fileUrl,
      fileHash: latestBundle.fileHash,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
