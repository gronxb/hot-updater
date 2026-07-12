import type { Bundle, HotUpdaterContext } from "./types";

export interface RequestBundleResolver {
  readonly hasSeededBundles: () => boolean;
  readonly peek: (bundleId: string) => Bundle | null;
  readonly getById: (
    bundleId: string,
    loadBundleById: () => Promise<Bundle | null>,
  ) => Promise<Bundle | null>;
}

type BundleCacheEntry = Bundle | null;

class RequestBundleCache {
  private readonly entries = new Map<string, BundleCacheEntry>();
  private readonly pendingLoads = new Map<string, Promise<Bundle | null>>();
  private readonly seededIds = new Set<string>();

  seed(seeds: readonly (Bundle | null | undefined)[]): void {
    for (const bundle of seeds) {
      if (!bundle) continue;
      this.seededIds.add(bundle.id);
      this.entries.set(bundle.id, bundle);
    }
  }

  hasSeeds(): boolean {
    return this.seededIds.size > 0;
  }

  peek(bundleId: string): Bundle | null {
    return this.entries.get(bundleId) ?? null;
  }

  async getById(
    bundleId: string,
    loadBundleById: () => Promise<Bundle | null>,
  ): Promise<Bundle | null> {
    if (this.entries.has(bundleId)) return this.entries.get(bundleId) ?? null;
    const pending = this.pendingLoads.get(bundleId);
    if (pending) return pending;

    const load = loadBundleById().then(
      (bundle) => {
        this.pendingLoads.delete(bundleId);
        if (!this.entries.has(bundleId)) this.entries.set(bundleId, bundle);
        return this.entries.get(bundleId) ?? null;
      },
      (error: unknown) => {
        this.pendingLoads.delete(bundleId);
        throw error;
      },
    );
    this.pendingLoads.set(bundleId, load);
    return load;
  }
}

const requestCaches = new WeakMap<object, RequestBundleCache>();

const isCacheContext = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const getRequestCache = (context: unknown): RequestBundleCache | null => {
  if (!isCacheContext(context)) return null;
  const current = requestCaches.get(context);
  if (current) return current;
  const created = new RequestBundleCache();
  requestCaches.set(context, created);
  return created;
};

export const seedRequestBundles = <TContext = unknown>(
  context: HotUpdaterContext<TContext> | undefined,
  seeds: readonly (Bundle | null | undefined)[],
): void => {
  getRequestCache(context)?.seed(seeds);
};

export const createRequestBundleResolver = <TContext = unknown>(
  context: HotUpdaterContext<TContext> | undefined,
): RequestBundleResolver => {
  const cache = getRequestCache(context) ?? new RequestBundleCache();
  return {
    hasSeededBundles: () => cache.hasSeeds(),
    peek: (bundleId) => cache.peek(bundleId),
    getById: (bundleId, loadBundleById) =>
      cache.getById(bundleId, loadBundleById),
  };
};
