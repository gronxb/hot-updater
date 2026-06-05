import fs from "fs/promises";
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

export type LoadHotUpdaterConfigRuntimeOptions = {
  configPath?: string;
  cwd?: string;
};

const getDefaultPlatformConfig = (cwd: string): ConfigInput["platform"] => {
  // Find actual Info.plist files in the ios directory
  let infoPlistPaths: string[] = []; // fallback
  try {
    const plistFiles = fg.sync("**/Info.plist", {
      cwd: path.join(cwd, "ios"),
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

  // Find actual AndroidManifest.xml files in the android directory
  let androidManifestPaths: string[] = []; // fallback
  try {
    const manifestFiles = fg.sync(path.join("**", "AndroidManifest.xml"), {
      cwd: path.join(cwd, "android"),
      absolute: false,
      onlyFiles: true,
      ignore: ["**/build/**", "**/.gradle/**"],
    });

    if (manifestFiles.length > 0) {
      // Convert to relative paths from project root
      androidManifestPaths = manifestFiles.map((file: string) =>
        path.join("android", file),
      );
    }
  } catch {
    // Keep fallback value if glob fails
  }

  // Find actual strings.xml files in the android directory
  let stringResourcePaths: string[] = []; // fallback
  try {
    const stringsFiles = fg.sync(path.join("**", "strings.xml"), {
      cwd: path.join(cwd, "android"),
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
      androidManifestPaths,
      stringResourcePaths,
    },
    ios: {
      infoPlistPaths,
    },
  };
};

const getDefaultConfig = (cwd: string): ConfigInput => {
  return {
    cacheDir: path.join("node_modules", ".hot-updater"),
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
    platform: getDefaultPlatformConfig(cwd),
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
  runtimeOptions: Required<LoadHotUpdaterConfigRuntimeOptions>,
): LoadConfigOptions<ConfigInput> => {
  const configExtension = path.extname(runtimeOptions.configPath);
  const configBasename = configExtension
    ? path.basename(runtimeOptions.configPath, configExtension)
    : undefined;

  return {
    cwd: runtimeOptions.cwd,
    stopAt: path.dirname(runtimeOptions.cwd),
    merge: false,
    sources: [
      {
        files: configBasename ?? "hot-updater.config",
        extensions: configExtension
          ? [configExtension.slice(1)]
          : ["js", "cjs", "ts", "cts", "mjs", "mts"],
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

const resolveExplicitConfigPath = async (
  configPath: string,
): Promise<string> => {
  const resolvedPath = path.resolve(configPath);

  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Hot Updater config path is not a file: ${resolvedPath}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes(resolvedPath)) {
      throw error;
    }
    throw new Error(`Hot Updater config path does not exist: ${resolvedPath}`);
  }

  return resolvedPath;
};

const resolveRuntimeOptions = async (
  runtimeOptions?: LoadHotUpdaterConfigRuntimeOptions,
): Promise<Required<LoadHotUpdaterConfigRuntimeOptions>> => {
  const explicitConfigPath =
    runtimeOptions?.configPath ?? process.env["HOT_UPDATER_CONFIG_PATH"];

  if (explicitConfigPath) {
    const configPath = await resolveExplicitConfigPath(explicitConfigPath);
    return {
      configPath,
      cwd: runtimeOptions?.cwd ?? path.dirname(configPath),
    };
  }

  return {
    configPath: "",
    cwd: runtimeOptions?.cwd ?? getCwd(),
  };
};

export const loadConfig = async (
  options: HotUpdaterConfigOptions,
  runtimeOptions?: LoadHotUpdaterConfigRuntimeOptions,
): Promise<ConfigResponse> => {
  const resolvedRuntimeOptions = await resolveRuntimeOptions(runtimeOptions);
  const { config } = await loadUnconfig<ConfigInput>(
    getConfigLoaderOptions(options, resolvedRuntimeOptions),
  );

  return mergeConfigSources(
    config,
    getDefaultConfig(resolvedRuntimeOptions.cwd),
  ) as ConfigResponse;
};
