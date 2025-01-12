import type {
  Bundle,
  BundleArg,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";

export const ensureUpdateInfo = async (
  source: BundleArg,
  { appVersion, bundleId, platform }: GetBundlesArgs,
  requestHeaders?: Record<string, string>,
): Promise<Bundle[] | UpdateInfo> => {
  try {
    let bundles: Bundle[] | null = null;
    if (typeof source === "string") {
      if (source.startsWith("http")) {
        return await fetch(source, {
          headers: {
            "x-app-platform": platform,
            "x-app-version": appVersion,
            "x-bundle-id": bundleId,
            ...requestHeaders,
          },
        }).then((res) => res.json());
      }
    } else if (typeof source === "function") {
      bundles = await source();
    } else {
      bundles = source;
    }

    return bundles ?? [];
  } catch {
    return [];
  }
};
