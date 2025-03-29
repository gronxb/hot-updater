import type {
  BasePluginArgs,
  Bundle,
  DatabasePlugin,
  DatabasePluginHooks,
} from "@hot-updater/plugin-core";

import Pocketbase from "pocketbase";
import type { PocketbaseBundle } from "./types";

export interface PocketbaseDatabaseConfig {
  host: string
  publicUrl?: string
  bundlesCollection?: string
}

interface PocketbasePluginArgs extends  BasePluginArgs {
  pocketbaseClient?: Pocketbase
}

const remapBundleIds = (bundle: PocketbaseBundle): Bundle => {
  const { id, bundleId, ...rest } = bundle;

  return {
    id: bundleId,
    ...rest,
  };
}

export const pocketbaseDatabase =
  (config: PocketbaseDatabaseConfig, hooks?: DatabasePluginHooks) =>
  ({pocketbaseClient}: PocketbasePluginArgs): DatabasePlugin => {

    const pbClient = pocketbaseClient ?? new Pocketbase(config.host)

    const bundlesCollection = pbClient.collection(config.bundlesCollection ?? 'bundles')

    if (!bundlesCollection) {
      throw new Error(`Collection ${config.bundlesCollection} not found`);
    }

    return {
      name: "pocketbaseDatabase",
      async commitBundle() {
        await hooks?.onDatabaseUpdated?.();
      },
      async updateBundle(targetBundleId: string, newBundle: Partial<Bundle>) {
        const bundleRecord = await bundlesCollection.getFirstListItem<Bundle>(`bundleId="${targetBundleId}"`) ?? null

        if (!bundleRecord) {
          throw new Error(`Bundle with id ${targetBundleId} not found`);
        }

        await bundlesCollection.update<Bundle>(bundleRecord.id, newBundle)
      },
      async appendBundle(inputBundle: Bundle) {
        const {id: bundleId, ...bundleData}  = inputBundle

        const bundleRecord = await bundlesCollection.getFirstListItem<PocketbaseBundle>(`bundleId="${bundleId}"`) ?? null

        if (!bundleRecord) {
          throw new Error(`Bundle with id ${bundleId} not found`);
        }

        await bundlesCollection.update<PocketbaseBundle>(bundleRecord.id, {
          bundleId,
          ...bundleData,
        })
      },
      async getBundleById(hotUpdateBundleId: string) {
        const bundle = await bundlesCollection.getFirstListItem<PocketbaseBundle>(`bundleId="${hotUpdateBundleId}"`) ?? null

        return remapBundleIds(bundle);
      },
      async getBundles() {
        const bundles = await bundlesCollection.getFullList<PocketbaseBundle>()
        return bundles.map(remapBundleIds).sort((a, b) => a.id.localeCompare(b.id));
      },
    };
  };
