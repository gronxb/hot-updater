import { cosmiconfig } from "cosmiconfig";
import { TypeScriptLoader } from "cosmiconfig-typescript-loader";
import { getCwd } from "./cwd.js";
import type { Config } from "./types.js";

export const loadConfig = async (): Promise<Config | null> => {
  const result = await cosmiconfig("hot-updater", {
    stopDir: getCwd(),
    searchPlaces: [
      "hot-updater.config.js",
      "hot-updater.config.cjs",
      "hot-updater.config.ts",
      "hot-updater.config.cts",
      "hot-updater.config.mjs",
      "hot-updater.config.cjs",
    ],
    ignoreEmptySearchPlaces: false,
    loaders: {
      ".ts": TypeScriptLoader(),
      ".mts": TypeScriptLoader(),
      ".cts": TypeScriptLoader(),
    },
  }).search();

  if (!result?.config) {
    return null;
  }

  return result.config as Config;
};
