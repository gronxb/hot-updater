import type { BundlePatchRow } from "../types";

const patchHydrationKey: unique symbol = Symbol.for(
  "@hot-updater/plugin-core/patch-hydration/v1",
);

export interface DatabasePluginPatchHydration {
  loadPatches(ownerIds: readonly string[]): Promise<readonly BundlePatchRow[]>;
}

interface DatabasePluginPatchHydrationCarrier {
  readonly [patchHydrationKey]?: DatabasePluginPatchHydration;
}

export const attachDatabasePluginPatchHydration = <TPlugin extends object>(
  plugin: TPlugin,
  hydration: DatabasePluginPatchHydration,
): TPlugin => {
  Object.defineProperty(plugin, patchHydrationKey, {
    configurable: false,
    enumerable: false,
    value: hydration,
    writable: false,
  });
  return plugin;
};

export const getDatabasePluginPatchHydration = (
  plugin: object,
): DatabasePluginPatchHydration | undefined =>
  (plugin as DatabasePluginPatchHydrationCarrier)[patchHydrationKey];
