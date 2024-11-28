import type { Bundle, BundleArg } from "@hot-updater/utils";
import { filterTargetVersion } from "@hot-updater/utils";
import { Platform } from "react-native";
import { checkForRollback } from "./checkForRollback";
import { NIL_UUID } from "./const";
import { getAppVersion, getBundleId } from "./native";

export type UpdateStatus = "ROLLBACK" | "UPDATE";

const findLatestBundles = (bundles: Bundle[]) => {
  return (
    bundles
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.id.localeCompare(a.id))?.[0] ?? null
  );
};

const ensureBundles = async (bundle: BundleArg) => {
  try {
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

    return bundles ?? [];
  } catch {
    return [];
  }
};

export const checkForUpdate = async (
  bundles: BundleArg,
): Promise<{
  id: string;
  forceUpdate: boolean;
  file: string | null;
  hash: string | null;
  status: UpdateStatus;
} | null> => {
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
      if (latestBundle.id === currentBundleId) {
        return null;
      }
      if (latestBundle.id > currentBundleId) {
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

  if (latestBundle.id.localeCompare(currentBundleId) > 0) {
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
