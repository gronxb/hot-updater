import type { Bundle } from "./types";

export interface RequestBundleResolver {
  readonly getById: (
    bundleId: string,
    loadBundleById: () => Promise<Bundle | null>,
  ) => Promise<Bundle | null>;
}

export const createRequestBundleResolver = (): RequestBundleResolver => {
  const entries = new Map<string, Bundle | null>();
  const pendingLoads = new Map<string, Promise<Bundle | null>>();

  return {
    async getById(bundleId, loadBundleById) {
      if (entries.has(bundleId)) return entries.get(bundleId) ?? null;
      const pending = pendingLoads.get(bundleId);
      if (pending) return pending;

      const load = loadBundleById().then(
        (bundle) => {
          pendingLoads.delete(bundleId);
          if (!entries.has(bundleId)) entries.set(bundleId, bundle);
          return entries.get(bundleId) ?? null;
        },
        (error: unknown) => {
          pendingLoads.delete(bundleId);
          throw error;
        },
      );
      pendingLoads.set(bundleId, load);
      return load;
    },
  };
};
