import { BundleUnitOfWork } from "./bundleUnitOfWork";
import { getRequestBundleUnitOfWork } from "./bundleUnitOfWorkStore";
import type { Bundle, HotUpdaterContext } from "./types";

export interface RequestUpdateBundleResolver {
  readonly hasSeededBundles: () => boolean;
  readonly peek: (bundleId: string) => Bundle | null;
  readonly getById: (
    bundleId: string,
    loadBundleById: () => Promise<Bundle | null>,
  ) => Promise<Bundle | null>;
}

const toBundleSeeds = (
  seeds: readonly (Bundle | null | undefined)[],
): readonly Bundle[] => seeds.filter((seed): seed is Bundle => !!seed);

export const seedRequestUpdateBundles = <TContext = unknown>(
  context: HotUpdaterContext<TContext> | undefined,
  seeds: readonly (Bundle | null | undefined)[],
) => {
  const unitOfWork = getRequestBundleUnitOfWork(context);
  if (!unitOfWork) {
    return;
  }

  const nextSeeds = toBundleSeeds(seeds);
  if (nextSeeds.length === 0) {
    return;
  }

  unitOfWork.seed(nextSeeds);
};

export const getRequestUpdateBundleSeeds = <TContext = unknown>(
  context: HotUpdaterContext<TContext> | undefined,
): readonly Bundle[] => {
  return getRequestBundleUnitOfWork(context)?.seededBundles() ?? [];
};

export const createRequestUpdateBundleResolver = <TContext = unknown>(
  context: HotUpdaterContext<TContext> | undefined,
): RequestUpdateBundleResolver => {
  const unitOfWork =
    getRequestBundleUnitOfWork(context) ?? new BundleUnitOfWork();

  return {
    hasSeededBundles: () => unitOfWork.hasSeeds(),
    peek: (bundleId) => unitOfWork.peek(bundleId),
    getById: (bundleId, loadBundleById) =>
      unitOfWork.getById(bundleId, loadBundleById),
  };
};
