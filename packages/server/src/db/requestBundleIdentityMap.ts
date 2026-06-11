import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterContext } from "@hot-updater/plugin-core";

type LoadBundleById<TContext> = (
  bundleId: string,
  context?: HotUpdaterContext<TContext>,
) => Promise<Bundle | null>;

type RequestBundleIdentityMapOptions<TContext> = {
  readonly context?: HotUpdaterContext<TContext>;
  readonly loadBundleById: LoadBundleById<TContext>;
  readonly seeds: readonly (Bundle | null | undefined)[];
};

export const createRequestBundleIdentityMap = <TContext = unknown>({
  context,
  loadBundleById,
  seeds,
}: RequestBundleIdentityMapOptions<TContext>) => {
  const bundles = new Map<string, Bundle>();
  const pendingBundles = new Map<string, Promise<Bundle | null>>();

  for (const seed of seeds) {
    if (seed) {
      bundles.set(seed.id, seed);
    }
  }

  const get = async (bundleId: string): Promise<Bundle | null> => {
    const cachedBundle = bundles.get(bundleId);
    if (cachedBundle) {
      return cachedBundle;
    }

    const pendingBundle = pendingBundles.get(bundleId);
    if (pendingBundle) {
      return pendingBundle;
    }

    const lookup = loadBundleById(bundleId, context).then(
      (bundle) => {
        pendingBundles.delete(bundleId);
        if (bundle) {
          bundles.set(bundle.id, bundle);
        }
        return bundle;
      },
      (error: unknown) => {
        pendingBundles.delete(bundleId);
        throw error;
      },
    );
    pendingBundles.set(bundleId, lookup);
    return lookup;
  };

  return { get };
};
