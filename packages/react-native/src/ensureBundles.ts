import type {
  Bundle,
  BundleArg,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";

export const ensureBundles = async (
  bundle: BundleArg,
  { appVersion, bundleId, platform }: GetBundlesArgs,
): Promise<Bundle[] | UpdateInfo> => {
  try {
    let bundles: Bundle[] | null = null;
    if (typeof bundle === "string") {
      if (bundle.startsWith("http")) {
        return await fetch(bundle, {
          headers: {
            "x-app-platform": platform,
            "x-app-version": appVersion,
            "x-bundle-id": bundleId,
          },
        }).then((res) => res.json());
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
