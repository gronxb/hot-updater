import type { Bundle, BundleArg } from "@hot-updater/utils";

export const ensureBundles = async (bundle: BundleArg) => {
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
