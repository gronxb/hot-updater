import { checkForRollback } from "./checkForRollback";
import { filterAppVersion } from "./filterAppVersion";
import type { Bundle, Platform } from "./types";
import { NIL_UUID } from "./uuid";

export type UpdateStatus = "ROLLBACK" | "UPDATE";

const findLatestBundles = (bundles: Bundle[]) => {
  return (
    bundles
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.id.localeCompare(a.id))?.[0] ?? null
  );
};

export interface GetBundlesArgs {
  platform: Platform;
  bundleId: string;
  appVersion: string;
}

export interface BundleUpdateInfo {
  id: string;
  forceUpdate: boolean;
  file: string | null;
  hash: string | null;
  status: UpdateStatus;
}

export const checkForUpdate = async (
  bundles: Bundle[],
  { platform, bundleId, appVersion }: GetBundlesArgs,
): Promise<BundleUpdateInfo | null> => {
  const platformBundles = bundles.filter((b) => b.platform === platform);

  const appVersionBundles = filterAppVersion(platformBundles, appVersion);

  const isRollback = checkForRollback(appVersionBundles, bundleId);
  const latestBundle = await findLatestBundles(appVersionBundles);

  if (!latestBundle) {
    if (isRollback) {
      return {
        id: NIL_UUID,
        forceUpdate: true,
        file: null,
        hash: null,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

    return null;
  }

  if (latestBundle.file)
    if (isRollback) {
      if (latestBundle.id === bundleId) {
        return null;
      }
      if (latestBundle.id.localeCompare(bundleId) > 0) {
        return {
          id: latestBundle.id,
          forceUpdate: latestBundle.forceUpdate,
          file: latestBundle.file,
          hash: latestBundle.hash,
          status: "UPDATE" as UpdateStatus,
        };
      }
      return {
        id: latestBundle.id,
        forceUpdate: true,
        file: latestBundle.file,
        hash: latestBundle.hash,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

  if (latestBundle.id.localeCompare(bundleId) > 0) {
    return {
      id: latestBundle.id,
      forceUpdate: latestBundle.forceUpdate,
      file: latestBundle.file,
      hash: latestBundle.hash,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
