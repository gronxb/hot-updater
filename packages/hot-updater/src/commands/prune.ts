import * as p from "@clack/prompts";
import { type Platform, getCwd } from "@hot-updater/plugin-core";
import { loadConfig } from "@hot-updater/plugin-core";

export interface PruneOptions {
  platform: Platform;
}

export const prune = async (options: PruneOptions) => {
  const s = p.spinner();

  try {
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
    const bundles = await deployPlugin.getBundles();

    const activeBundles = bundles.filter((bundle) => bundle.enabled);
    const inactiveBundles = bundles.filter((bundle) => !bundle.enabled);

    if (inactiveBundles.length === 0) {
      s.stop("No inactive versions found", -1);
      return;
    }

    s.message("Pruning updates");

    await deployPlugin.setBundles(activeBundles);
    await deployPlugin.commitBundle();

    for (const bundle of inactiveBundles) {
      const key = await deployPlugin.deleteBundle(options.platform, bundle.id);
      p.log.info(`deleting: ${key}`);
    }

    s.stop("Done");
  } catch (e) {
    s.stop("Pruning Failed !", -1);
    console.error(e);
    process.exit(-1);
  }
};
