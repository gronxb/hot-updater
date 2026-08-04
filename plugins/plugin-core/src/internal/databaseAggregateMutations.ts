import type {
  BundlePatchRow,
  BundleRow,
  BundleRowUpdate,
  DatabasePlugin,
} from "../types";

const aggregateMutationsKey: unique symbol = Symbol.for(
  "@hot-updater/plugin-core/atomic-bundle-mutations/v1",
);

export interface DatabasePluginAggregateMutations {
  insertBundleWithPatches(input: {
    readonly bundle: BundleRow;
    readonly patches: readonly BundlePatchRow[];
  }): Promise<void>;
  updateBundleWithPatches(input: {
    readonly bundleId: string;
    readonly update: BundleRowUpdate;
    readonly patches: readonly BundlePatchRow[];
  }): Promise<boolean>;
}

interface DatabasePluginAggregateMutationsCarrier {
  readonly [aggregateMutationsKey]?: DatabasePluginAggregateMutations;
}

export const attachDatabasePluginAggregateMutations = <
  TPlugin extends DatabasePlugin,
>(
  plugin: TPlugin,
  mutations: DatabasePluginAggregateMutations,
): TPlugin => {
  Object.defineProperty(plugin, aggregateMutationsKey, {
    configurable: false,
    enumerable: false,
    value: mutations,
    writable: false,
  });
  return plugin;
};

export const getDatabasePluginAggregateMutations = (
  plugin: DatabasePlugin,
): DatabasePluginAggregateMutations | undefined =>
  (plugin as DatabasePlugin & DatabasePluginAggregateMutationsCarrier)[
    aggregateMutationsKey
  ];
