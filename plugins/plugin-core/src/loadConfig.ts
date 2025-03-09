import { cosmiconfig, cosmiconfigSync } from "cosmiconfig";
import { TypeScriptLoader } from "cosmiconfig-typescript-loader";
import { getCwd } from "./cwd.js";
import type { Config, Platform } from "./types.js";

export type HotUpdaterConfigOptions = {
  platform: Platform;
  channel: string;
} | null;

export const loadConfig = async (
  options: HotUpdaterConfigOptions,
): Promise<Config | null> => {
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

  if (typeof result.config === "function") {
    return await result.config(options);
  }

  return result.config as Config;
};

export const loadConfigSync = (
  options: HotUpdaterConfigOptions,
): Config | null => {
  const result = cosmiconfigSync("hot-updater", {
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

  if (typeof result.config === "function") {
    return result.config(options);
  }

  return result.config as Config;
};
