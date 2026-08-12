import type { Bundle } from "@hot-updater/plugin-core";
import { bundleToRow } from "@hot-updater/plugin-core";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import { StandaloneDatabaseError } from "./standaloneHttp";
import {
  createLegacyCompatibilityImplementation,
  type StandaloneLegacyImplementation,
} from "./standaloneLegacyImplementation";

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
  loadChannels: StandaloneBundleRemote["loadChannels"],
  insertChannel: StandaloneBundleRemote["insertChannel"],
  deleteChannel: StandaloneBundleRemote["deleteChannel"],
): StandaloneBundleRemote => {
  const loadBundleRows = async () => {
    const channelIds = new Map(
      (await loadChannels()).map(({ id, name }) => [name, id]),
    );
    return [...bundles.values()].map((bundle) => {
      const channelId = channelIds.get(bundle.channel);
      if (!channelId) {
        throw new StandaloneDatabaseError(
          "invalid-response",
          `Bundle ${bundle.id} references an unknown Channel ${bundle.channel}.`,
          500,
        );
      }
      return bundleToRow(bundle, channelId);
    });
  };
  return {
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
    loadBundleRow: async (bundleId) =>
      (await loadBundleRows()).find(({ id }) => id === bundleId) ?? null,
    loadBundleRows,
    loadBundles: async () => [...bundles.values()].map(cloneBundle),
    loadBundleWindow: async () => null,
    loadChannels,
    insertChannel,
    deleteChannel,
    updateBundle: async (bundle) => {
      bundles.set(bundle.id, cloneBundle(bundle));
    },
  };
};

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
  callback: (transaction: StandaloneLegacyImplementation) => Promise<TResult>,
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
    createLegacyCompatibilityImplementation(
      createStagedRemote(
        staged,
        remote.loadChannels,
        remote.insertChannel,
        remote.deleteChannel,
      ),
    ),
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
