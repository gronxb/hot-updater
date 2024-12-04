import * as p from "@clack/prompts";
import { getCwd } from "@hot-updater/plugin-core";
import { loadConfig } from "@hot-updater/plugin-core";

export const prune = async () => {
  const s = p.spinner();

  try {
    const config = await loadConfig();
    if (!config) {
      console.error("No config found. Please run `hot-updater init` first.");
      process.exit(1);
    }

    const cwd = getCwd();

    const databasePlugin = config.database({
      cwd,
    });

    s.start("Checking existing updates");
    const bundles = await databasePlugin.getBundles();

    const activeBundles = bundles.filter((bundle) => bundle.enabled);
    const inactiveBundles = bundles.filter((bundle) => !bundle.enabled);

    if (inactiveBundles.length === 0) {
      s.stop("No inactive versions found", -1);
      return;
    }

    s.message("Pruning updates");

    await databasePlugin.setBundles(activeBundles);
    await databasePlugin.commitBundle();
    await databasePlugin.onUnmount?.();

    const storagePlugin = config.storage({
      cwd,
    });

    for (const bundle of inactiveBundles) {
      const key = await storagePlugin.deleteBundle(bundle.id);
      p.log.info(`deleting: ${key}`);
    }

    s.stop("Done");
  } catch (e) {
    s.stop("Pruning Failed !", -1);
    console.error(e);
    process.exit(-1);
  }
};
