import type { DatabasePluginImplementation } from "@hot-updater/plugin-core";

import { createStandaloneBundleRemote } from "./standaloneBundleRemote";
import { createLegacyReads } from "./standaloneLegacyReads";
import { createLegacyWrites } from "./standaloneLegacyWrites";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

export const createLegacyCompatibilityImplementation = (
  config: StandaloneRepositoryConfig,
): DatabasePluginImplementation => {
  const remote = createStandaloneBundleRemote(config);
  return {
    ...createLegacyWrites(remote),
    ...createLegacyReads(remote),
    getChannels: () => remote.loadChannels(),
  };
};
