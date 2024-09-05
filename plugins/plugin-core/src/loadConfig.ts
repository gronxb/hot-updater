import { cosmiconfig } from "cosmiconfig";
import { TypeScriptLoader } from "cosmiconfig-typescript-loader";
import { getCwd } from "./cwd.js";
import type { Config } from "./types.js";

export const loadConfig = async () => {
  const result = await cosmiconfig("hot-updater", {
    stopDir: getCwd(),
    searchPlaces: [
      "hot-updater.config.js",
      "hot-updater.config.cjs",
      "hot-updater.config.ts",
    ],
    ignoreEmptySearchPlaces: false,
    loaders: {
      ".ts": TypeScriptLoader(),
    },
  }).search();

  return result?.config as Config;
};
