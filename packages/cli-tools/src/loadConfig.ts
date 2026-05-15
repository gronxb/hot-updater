import path from "path";

import type {
  ConfigInput,
  Platform,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import { merge } from "es-toolkit";
import fg from "fast-glob";
import { type LoadConfigOptions, loadConfig as loadUnconfig } from "unconfig";

import { getCwd } from "./cwd.js";

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
      ignore: [
        "**/Pods/**",
        "**/build/**",
        "**/Build/**",
        "**/*.app/**",
        "**/*.xcarchive/**",
      ],
    });

    if (plistFiles.length > 0) {
      // Convert to relative paths from project root
      infoPlistPaths = plistFiles.map((file: string) => `ios/${file}`);
    }
  } catch {
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
  } catch {
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
    updateStrategy: "appVersion",
    compressStrategy: "zip",
    fingerprint: {
      extraSources: [],
    },
    patch: {
      enabled: true,
      maxBaseBundles: 3,
    },
    console: {
      port: 1422,
    },
    platform: getDefaultPlatformConfig(),
    nativeBuild: { android: {}, ios: {} },
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

const mergeConfigSources = (
  ...sources: Array<ConfigInput | null | undefined>
) => {
  return sources.reduceRight<ConfigInput>(
    (mergedConfig, source) => merge(mergedConfig, source ?? {}),
    {} as ConfigInput,
  );
};

const getConfigLoaderOptions = (
  options: HotUpdaterConfigOptions,
): LoadConfigOptions<ConfigInput> => {
  const cwd = getCwd();

  return {
    cwd,
    stopAt: path.dirname(cwd),
    merge: false,
    sources: [
      {
        files: "hot-updater.config",
        extensions: ["js", "cjs", "ts", "cts", "mjs", "mts"],
        rewrite: async (config: unknown) => {
          return typeof config === "function"
            ? (config as (options: HotUpdaterConfigOptions) => ConfigInput)(
                options,
              )
            : (config as ConfigInput);
        },
      },
    ],
  };
};

export const loadConfig = async (
  options: HotUpdaterConfigOptions,
): Promise<ConfigResponse> => {
  const { config } = await loadUnconfig<ConfigInput>(
    getConfigLoaderOptions(options),
  );

  return mergeConfigSources(config, getDefaultConfig()) as ConfigResponse;
};
