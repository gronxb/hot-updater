import { cosmiconfig, cosmiconfigSync } from "cosmiconfig";
import { TypeScriptLoader } from "cosmiconfig-typescript-loader";
import { merge } from "es-toolkit";
import { getCwd } from "./cwd.js";
import type { ConfigInput, Platform } from "./types/index.js";
import type { RequiredDeep } from "./types/utils.js";

export type HotUpdaterConfigOptions = {
  platform: Platform;
  channel: string;
} | null;

const defaultConfig: ConfigInput = {
  releaseChannel: "production",
  console: {
    port: 1422,
  },
  build: () => {
    throw new Error("build plugin is required");
  },
  storage: () => {
    throw new Error("storage plugin is required");
  },
  database: () => {
    throw new Error("database plugin is required");
  },
};

export type ConfigResponse = RequiredDeep<ConfigInput>;

export const loadConfig = async (
  options: HotUpdaterConfigOptions,
): Promise<ConfigResponse> => {
  const result = await cosmiconfig("hot-updater", {
    stopDir: getCwd(),
    searchPlaces: [
      "hot-updater.config.js",
      "hot-updater.config.cjs",
      "hot-updater.config.ts",
      "hot-updater.config.cts",
      "hot-updater.config.cjs",
    ],
    ignoreEmptySearchPlaces: false,
    loaders: {
      ".ts": TypeScriptLoader(),
      ".mts": TypeScriptLoader(),
      ".cts": TypeScriptLoader(),
    },
  }).search();

  const config =
    typeof result?.config === "function"
      ? result.config(options)
      : (result?.config as ConfigInput);

  return merge(defaultConfig, config ?? {});
};

export const loadConfigSync = (
  options: HotUpdaterConfigOptions,
): ConfigResponse => {
  const result = cosmiconfigSync("hot-updater", {
    stopDir: getCwd(),
    searchPlaces: [
      "hot-updater.config.js",
      "hot-updater.config.cjs",
      "hot-updater.config.ts",
      "hot-updater.config.cts",
      "hot-updater.config.cjs",
    ],
    ignoreEmptySearchPlaces: false,
    loaders: {
      ".ts": TypeScriptLoader(),
      ".mts": TypeScriptLoader(),
      ".cts": TypeScriptLoader(),
    },
  }).search();

  const config =
    typeof result?.config === "function"
      ? result.config(options)
      : (result?.config as ConfigInput);

  return merge(defaultConfig, config ?? {});
};
