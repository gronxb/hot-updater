import type { Bundle, BundleArg } from "@hot-updater/utils";
import { filterTargetVersion } from "@hot-updater/utils";
import { Platform } from "react-native";
import { getAppVersion, getBundleId } from "./native";
import { isNullable } from "./utils";

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type UpdateStatus = "ROLLBACK" | "UPDATE";

const findLatestBundles = (bundles: Bundle[]) => {
  return (
    bundles
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.bundleId.localeCompare(a.bundleId))?.[0] ?? null
  );
};

const checkForRollback = (bundles: Bundle[], currentBundleId: string) => {
  const enabled = bundles?.find(
    (item) => item.bundleId === currentBundleId,
  )?.enabled;
  const availableOldVersion = bundles?.find(
    (item) => item.bundleId < currentBundleId && item.enabled,
  )?.enabled;

  if (isNullable(enabled)) {
    return availableOldVersion;
  }
  return !enabled;
};

const ensureBundles = async (bundle: BundleArg) => {
  let bundles: Bundle[] | null = null;
  if (typeof bundle === "string") {
    if (bundle.startsWith("http")) {
      const response = await fetch(bundle);
      bundles = (await response.json()) as Bundle[];
    }
  } else if (typeof bundle === "function") {
    bundles = await bundle();
  } else {
    bundles = bundle;
  }
  if (!bundles) {
    throw new Error("Invalid bundle");
  }
  return bundles;
};

export const checkForUpdate = async (bundles: BundleArg) => {
  const $bundles = await ensureBundles(bundles);

  const currentAppVersion = await getAppVersion();
  const platform = Platform.OS as "ios" | "android";

  const appVersionBundles = currentAppVersion
    ? filterTargetVersion($bundles, currentAppVersion, platform)
    : [];
  const currentBundleId = await getBundleId();

  const isRollback = checkForRollback(appVersionBundles, currentBundleId);
  const latestBundle = await findLatestBundles(appVersionBundles);

  if (!latestBundle) {
    if (isRollback) {
      return {
        bundleId: NIL_UUID,
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
      if (latestBundle.bundleId === currentBundleId) {
        return null;
      }
      if (latestBundle.bundleId > currentBundleId) {
        return {
          bundleId: latestBundle.bundleId,
          forceUpdate: latestBundle.forceUpdate,
          file: latestBundle.file,
          hash: latestBundle.hash,
          status: "UPDATE" as UpdateStatus,
        };
      }
      return {
        bundleId: latestBundle.bundleId,
        forceUpdate: true,
        file: latestBundle.file,
        hash: latestBundle.hash,
        status: "ROLLBACK" as UpdateStatus,
      };
    }

  if (latestBundle.bundleId.localeCompare(currentBundleId) > 0) {
    return {
      bundleId: latestBundle.bundleId,
      forceUpdate: latestBundle.forceUpdate,
      file: latestBundle.file,
      hash: latestBundle.hash,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
