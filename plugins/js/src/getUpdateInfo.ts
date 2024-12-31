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

  const isRollback = checkForRollback(filteredBundles, bundleId);
  const latestBundle = await findLatestBundles(filteredBundles);

  if (!latestBundle) {
    if (isRollback) {
      return {
        id: NIL_UUID,
        forceUpdate: true,
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
          forceUpdate: latestBundle.forceUpdate,
          fileUrl: latestBundle.fileUrl,
          fileHash: latestBundle.fileHash,
          status: "UPDATE" as UpdateStatus,
        };
      }
      return {
        id: latestBundle.id,
        forceUpdate: true,
        fileUrl: latestBundle.fileUrl,
        fileHash: latestBundle.fileHash,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

  if (latestBundle.id.localeCompare(bundleId) > 0) {
    return {
      id: latestBundle.id,
      forceUpdate: latestBundle.forceUpdate,
      fileUrl: latestBundle.fileUrl,
      fileHash: latestBundle.fileHash,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
