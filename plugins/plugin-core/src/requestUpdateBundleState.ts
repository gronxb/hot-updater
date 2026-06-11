import type { Bundle, HotUpdaterContext } from "./types";

const requestUpdateBundleSeeds = new WeakMap<object, readonly Bundle[]>();

const isWeakMapKey = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const toBundleSeeds = (
  seeds: readonly (Bundle | null | undefined)[],
): readonly Bundle[] => seeds.filter((seed): seed is Bundle => !!seed);

export const seedRequestUpdateBundles = <TContext = unknown>(
  context: HotUpdaterContext<TContext> | undefined,
  seeds: readonly (Bundle | null | undefined)[],
) => {
  if (!isWeakMapKey(context)) {
    return;
  }

  const nextSeeds = toBundleSeeds(seeds);
  if (nextSeeds.length === 0) {
    return;
  }

  const bundlesById = new Map<string, Bundle>();
  for (const seed of requestUpdateBundleSeeds.get(context) ?? []) {
    bundlesById.set(seed.id, seed);
  }
  for (const seed of nextSeeds) {
    bundlesById.set(seed.id, seed);
  }

  requestUpdateBundleSeeds.set(context, [...bundlesById.values()]);
};

export const getRequestUpdateBundleSeeds = <TContext = unknown>(
  context: HotUpdaterContext<TContext> | undefined,
): readonly Bundle[] => {
  if (!isWeakMapKey(context)) {
    return [];
  }

  return requestUpdateBundleSeeds.get(context) ?? [];
};
