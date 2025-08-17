import path from "path";
import {
  type CosmiconfigResult,
  cosmiconfig,
  cosmiconfigSync,
} from "cosmiconfig";
import { TypeScriptLoader } from "cosmiconfig-typescript-loader";
import { merge } from "es-toolkit";
import fg from "fast-glob";
import { getCwd } from "./cwd.js";
import type { ConfigInput, Platform } from "./types";
import type { RequiredDeep } from "./types/utils.js";

export type HotUpdaterConfigOptions = {
  platform: Platform;
  channel: string;
} | null;

const getDefaultPlatformConfig = (): ConfigInput["platform"] => {
  // Find actual Info.plist files in the ios directory
  let infoPlistPaths: string[] = []; // fallback
  try {
    const plistFiles = fg.sync("**/Info.plist", {
      cwd: path.join(getCwd(), "ios"),
      absolute: false,
      onlyFiles: true,
      ignore: ["**/Pods/**"],
    });

    if (plistFiles.length > 0) {
      // Convert to relative paths from project root
      infoPlistPaths = plistFiles.map((file: string) => `ios/${file}`);
    }
  } catch (error) {
    // Keep fallback value if glob fails
  }

  // Find actual strings.xml files in the android directory
  let stringResourcePaths: string[] = []; // fallback
  try {
    const stringsFiles = fg.sync(path.join("**", "strings.xml"), {
      cwd: path.join(getCwd(), "android"),
      absolute: false,
      onlyFiles: true,
    });

    if (stringsFiles.length > 0) {
      // Convert to relative paths from project root
      stringResourcePaths = stringsFiles.map((file: string) =>
        path.join("android", file),
      );
    }
  } catch (error) {
    // Keep fallback value if glob fails
  }

  return {
    android: {
      stringResourcePaths,
    },
    ios: {
      infoPlistPaths,
    },
  };
};

const getDefaultConfig = (): ConfigInput => {
  return {
    releaseChannel: "production",
    updateStrategy: "fingerprint",
    fingerprint: {
      extraSources: [],
      ignorePaths: [],
    },
    console: {
      port: 1422,
    },
    platform: getDefaultPlatformConfig(),
    nativeBuild: {
      android: {
        aab: true,
        variant: "Release",
        appModuleName: "app",
      },
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
};

export type ConfigResponse = RequiredDeep<ConfigInput>;

const configOptions = {
  stopDir: getCwd(),
  searchPlaces: [
    "hot-updater.config.js",
    "hot-updater.config.cjs",
    "hot-updater.config.ts",
    "hot-updater.config.cts",
    "hot-updater.config.cjs",
    "hot-updater.config.mts",
  ],
  ignoreEmptySearchPlaces: false,
  loaders: {
    ".ts": TypeScriptLoader(),
    ".mts": TypeScriptLoader(),
    ".cts": TypeScriptLoader(),
  },
};

const ensureConfig = (
  result: CosmiconfigResult,
  options: HotUpdaterConfigOptions,
) => {
  const config =
    typeof result?.config === "function"
      ? result.config(options)
      : (result?.config as ConfigInput);

  const defaultConfig = getDefaultConfig();

  return merge(defaultConfig, config ?? {});
};

export const loadConfig = async (
  options: HotUpdaterConfigOptions,
): Promise<ConfigResponse> => {
  const result = await cosmiconfig("hot-updater", configOptions).search();

  return ensureConfig(result, options);
};

export const loadConfigSync = (
  options: HotUpdaterConfigOptions,
): ConfigResponse => {
  const result = cosmiconfigSync("hot-updater", configOptions).search();
  return ensureConfig(result, options);
};
