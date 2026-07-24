import type {
  Bundle,
  DatabasePluginImplementation,
} from "@hot-updater/plugin-core";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import { StandaloneDatabaseError } from "./standaloneHttp";
import { createLegacyCompatibilityImplementation } from "./standaloneLegacyImplementation";

const cloneBundle = (bundle: Bundle): Bundle => structuredClone(bundle);

const changedBundleIds = (
  before: ReadonlyMap<string, Bundle>,
  after: ReadonlyMap<string, Bundle>,
): string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)),
  );

const createStagedRemote = (
  bundles: Map<string, Bundle>,
): StandaloneBundleRemote => ({
  createBundle: async (bundle) => {
    bundles.set(bundle.id, cloneBundle(bundle));
  },
  createBundles: async (createdBundles) => {
    for (const bundle of createdBundles) {
      bundles.set(bundle.id, cloneBundle(bundle));
    }
  },
  deleteBundle: async (bundleId) => {
    bundles.delete(bundleId);
  },
  loadBundle: async (bundleId) => {
    const bundle = bundles.get(bundleId);
    return bundle ? cloneBundle(bundle) : null;
  },
  loadBundles: async () => [...bundles.values()].map(cloneBundle),
  loadBundleWindow: async () => null,
  loadChannels: async () => [
    ...new Set([...bundles.values()].map(({ channel }) => channel)),
  ],
  updateBundle: async (bundle) => {
    bundles.set(bundle.id, cloneBundle(bundle));
  },
});

const commitBundle = async (
  remote: StandaloneBundleRemote,
  before: Bundle | undefined,
  after: Bundle | undefined,
): Promise<void> => {
  if (before === undefined && after !== undefined) {
    await remote.createBundle(after);
  } else if (after === undefined && before !== undefined) {
    await remote.deleteBundle(before.id);
  } else if (after !== undefined) {
    await remote.updateBundle(after);
  }
};

export const runLegacyAggregateTransaction = async <TResult>(
  remote: StandaloneBundleRemote,
  callback: (transaction: DatabasePluginImplementation) => Promise<TResult>,
): Promise<TResult> => {
  const initial = new Map(
    (await remote.loadBundles()).map((bundle) => [
      bundle.id,
      cloneBundle(bundle),
    ]),
  );
  const staged = new Map(
    [...initial].map(([id, bundle]) => [id, cloneBundle(bundle)]),
  );
  const result = await callback(
    createLegacyCompatibilityImplementation(createStagedRemote(staged)),
  );
  const changedIds = changedBundleIds(initial, staged);
  if (changedIds.length > 1) {
    const createdBundles = changedIds.flatMap((id) => {
      const bundle = staged.get(id);
      return initial.has(id) || bundle === undefined ? [] : [bundle];
    });
    if (createdBundles.length === changedIds.length) {
      await remote.createBundles(createdBundles);
      return result;
    }
    throw new StandaloneDatabaseError(
      "request-failed",
      "The standalone bundle API can atomically mutate only one bundle per transaction.",
      409,
    );
  }
  const changedId = changedIds[0];
  if (changedId !== undefined) {
    await commitBundle(remote, initial.get(changedId), staged.get(changedId));
  }
  return result;
};
