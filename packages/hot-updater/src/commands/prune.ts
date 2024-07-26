// import { getCwd } from "@/cwd.js";
// import { loadConfig } from "@/utils/loadConfig.js";
// import * as p from "@clack/prompts";
// import type { Platform } from "@hot-updater/internal";

// export interface PruneOptions {
//   platform: Platform;
// }

// export const prune = async (options: PruneOptions) => {
//   const s = p.spinner();

//   const { deploy } = await loadConfig();

//   const cwd = getCwd();

//   const deployPlugin = deploy({
//     cwd,
//     spinner: s,
//   });

//   s.start("Checking existing updates");
//   const updateSources = await deployPlugin.getUpdateJson();

//   const activeSources = updateSources.filter((source) => source.enabled);
//   const inactiveSources = updateSources.filter((source) => !source.enabled);

//   if (inactiveSources.length === 0) {
//     s.stop("No inactive versions found", -1);
//     return;
//   }

//   s.message("Pruning updates");

//   await deployPlugin.setUpdateJson(activeSources);
//   await deployPlugin.commitUpdateJson();

//   for (const source of inactiveSources) {
//     const key = await deployPlugin.deleteBundle(
//       options.platform,
//       source.bundleVersion,
//     );
//     p.log.info(`deleting: ${key}`);
//   }

//   s.stop("Done");
// };
