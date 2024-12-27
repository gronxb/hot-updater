import type { Bundle, BundleArg, Platform } from "@hot-updater/utils";
import { filterAppVersion } from "@hot-updater/utils";
import { checkForRollback } from "./checkForRollback";
import { NIL_UUID } from "./const";

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

export interface GetBundlesArgs {
  platform: Platform;
  bundleId: string;
  appVersion: string;
}

export const checkForUpdate = async (
  bundleArg: BundleArg,
  { platform, bundleId, appVersion }: GetBundlesArgs,
): Promise<{
  id: string;
  forceUpdate: boolean;
  file: string | null;
  hash: string | null;
  status: UpdateStatus;
} | null> => {
  const bundles = await ensureBundles(bundleArg);

  // const currentAppVersion = await getAppVersion();
  // const platform = Platform.OS as "ios" | "android";
  // const currentBundleId = await getBundleId();

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
      if (latestBundle.id > bundleId) {
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
