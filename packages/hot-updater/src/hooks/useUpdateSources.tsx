import type { DeployPlugin, Platform } from "@hot-updater/plugin-core";

import { filterTargetVersion } from "@hot-updater/core";
import { useAsyncMemo } from "./useAsyncMemo.js";

export interface UpdateSourcesOptions {
  deployPlugin: DeployPlugin;
  targetVersion?: string;
  platform?: Platform;
}

export const useUpdateSources = (options: UpdateSourcesOptions) => {
  const run = async () => {
    let targetVersion = "*";
    if (options.targetVersion) {
      targetVersion = options.targetVersion;
    }

    const deployPlugin = options.deployPlugin;

    const updateSources = await deployPlugin.getUpdateSources();
    const targetVersions = filterTargetVersion(
      updateSources,
      targetVersion,
      options?.platform,
    );

    if (targetVersions.length === 0) {
      return [];
    }

    return targetVersions;
  };

  const { data: updateSources, refresh } = useAsyncMemo(
    run,
    [],
    [options.platform],
  );
  return { updateSources, refresh };
};
