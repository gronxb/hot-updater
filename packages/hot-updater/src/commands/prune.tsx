import * as p from "@clack/prompts";
import { type Platform, getCwd } from "@hot-updater/plugin-core";
import { loadConfig } from "@hot-updater/plugin-core";

export interface PruneOptions {
  platform: Platform;
}

export const prune = async (options: PruneOptions) => {
  const s = p.spinner();

  const config = await loadConfig();
  if (!config) {
    console.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }

  const cwd = getCwd();

  const deployPlugin = config.deploy({
    cwd,
    // spinner: s,
  });

  s.start("Checking existing updates");
  const updateSources = await deployPlugin.getUpdateSources();

  const activeSources = updateSources.filter((source) => source.enabled);
  const inactiveSources = updateSources.filter((source) => !source.enabled);

  if (inactiveSources.length === 0) {
    s.stop("No inactive versions found", -1);
    return;
  }

  s.message("Pruning updates");

  await deployPlugin.setUpdateSources(activeSources);
  await deployPlugin.commitUpdateSource();

  for (const source of inactiveSources) {
    const key = await deployPlugin.deleteBundle(
      options.platform,
      source.bundleVersion,
    );
    p.log.info(`deleting: ${key}`);
  }

  s.stop("Done");
};
