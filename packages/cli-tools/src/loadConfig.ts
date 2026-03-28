import type {
  ConfigInput,
  Platform,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import { loadConfig as loadC12Config } from "c12";
import { merge } from "es-toolkit";
import fg from "fast-glob";
import path from "path";
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

const getConfigLoaderOptions = (options: HotUpdaterConfigOptions) => {
  return {
    name: "hot-updater",
    cwd: getCwd(),
    configFile: "hot-updater.config",
    rcFile: false,
    globalRc: false,
    packageJson: false,
    envName: false,
    extend: false,
    context: options as Record<string, unknown> | undefined,
    defaults: getDefaultConfig(),
    merger: mergeConfigSources,
  } as const;
};

export const loadConfig = async (
  options: HotUpdaterConfigOptions,
): Promise<ConfigResponse> => {
  const { config } = await loadC12Config<ConfigInput>(
    getConfigLoaderOptions(options),
  );
  return config as ConfigResponse;
};
