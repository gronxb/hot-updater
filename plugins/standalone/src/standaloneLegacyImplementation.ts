import type { DatabasePluginImplementation } from "@hot-updater/plugin-core";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import { createLegacyReads } from "./standaloneLegacyReads";
import { createLegacyWrites } from "./standaloneLegacyWrites";

export const createLegacyCompatibilityImplementation = (
  remote: StandaloneBundleRemote,
): DatabasePluginImplementation => {
  return {
    ...createLegacyWrites(remote),
    ...createLegacyReads(remote),
    getChannels: () => remote.loadChannels(),
  };
};
