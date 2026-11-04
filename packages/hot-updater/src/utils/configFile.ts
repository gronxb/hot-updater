import fs from "fs";
import path from "path";

/** The extensions loadConfig reads hot-updater.config with. */
const CONFIG_EXTENSIONS = ["js", "cjs", "ts", "cts", "mjs", "mts"];

/**
 * Whether `dir` holds hot-updater.config, which loadConfig reads from the
 * CLI's folder only. Without one, as at a monorepo's root, loadConfig
 * returns the defaults: the appVersion strategy and no adapters.
 */
export const hasConfigFile = (dir: string) =>
  CONFIG_EXTENSIONS.some((extension) =>
    fs.existsSync(path.join(dir, `hot-updater.config.${extension}`)),
  );

export const NO_CONFIG_FILE_MESSAGE =
  "No hot-updater.config.ts in this folder. Run this in your app's folder, the one that holds it.";
