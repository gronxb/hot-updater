import { cosmiconfig } from "cosmiconfig";
import { TypeScriptLoader } from "cosmiconfig-typescript-loader";
import { getCwd } from "./cwd.js";
import type { Config } from "./types.js";

export const loadConfig = async (platform = ""): Promise<Config | null> => {
  const searchPathList = [
    "code-updater.config.js",
    "code-updater.config.cjs",
    "code-updater.config.ts",
    "code-updater.config.cts",
    "code-updater.config.mjs",
  ];

  if (platform === "ios" || platform === "android") {
    searchPathList.unshift(`code-updater.config.${platform}.js`);
    searchPathList.unshift(`code-updater.config.${platform}.cjs`);
    searchPathList.unshift(`code-updater.config.${platform}.ts`);
    searchPathList.unshift(`code-updater.config.${platform}.cts`);
    searchPathList.unshift(`code-updater.config.${platform}.mjs`);
  }

  const result = await cosmiconfig("code-updater", {
    stopDir: getCwd(),
    searchPlaces: searchPathList,
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
