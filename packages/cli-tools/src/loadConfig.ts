import path from "path";

import type {
  AnyHotUpdaterPlugin,
  ConfigInput,
  ConfiguredDatabase,
  Platform,
  RequiredDeep,
  StorageAdapter,
} from "@hot-updater/plugin-core";
import { merge } from "es-toolkit";
import fg from "fast-glob";
import { type LoadConfigOptions, loadConfig as loadUnconfig } from "unconfig";

import { getCwd } from "./cwd.js";
import { normalizeSigningConfig } from "./localBundleSigning.js";

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

  // Find actual AndroidManifest.xml files in the android directory
  let androidManifestPaths: string[] = []; // fallback
  try {
    const manifestFiles = fg.sync(path.join("**", "AndroidManifest.xml"), {
      cwd: path.join(getCwd(), "android"),
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

  return {
    android: {
      androidManifestPaths,
    },
    ios: {
      infoPlistPaths,
    },
  };
};

const getDefaultConfig = (): Omit<ConfigInput, "database" | "storage"> => {
  return {
    cacheDir: path.join("node_modules", ".hot-updater"),
    updateStrategy: "appVersion",
    // `extraSources` is intentionally absent: the deep merge would let this
    // default array clobber a user-supplied platform-scoped object.
    fingerprint: {},
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
      throw new Error("build adapter is required");
    },
    plugins: [],
  };
};

export type ConfigResponse = RequiredDeep<
  Omit<ConfigInput, "database" | "storage" | "plugins" | "signing">
> & {
  /** The server's database, or `standaloneRepository(...)`; absent when the config names none. */
  database?: ConfiguredDatabase;
  /** Where the CLI uploads bundles; absent when the config names none. */
  storage?: StorageAdapter;
  /** The plugins the server runs; none when the config lists none. */
  plugins: readonly AnyHotUpdaterPlugin[];
  signing?: ReturnType<typeof normalizeSigningConfig>;
};

type ConfigSource = Partial<ConfigInput> | null | undefined;

const mergeConfigSources = (...sources: ConfigSource[]) => {
  const mergedConfig = sources.reduceRight<Partial<ConfigInput>>(
    (mergedConfig, source) => merge(mergedConfig, source ?? {}),
    {},
  );

  // Taken whole, as the config made them: a deep merge copies objects
  // without their symbol keys, such as the brand on Hot Updater's own plugins.
  const database = sources.find((source) => source?.database)?.database;
  const plugins = sources.find((source) => source?.plugins)?.plugins;
  const signing = sources.find((source) => source?.signing)?.signing;
  const storage = sources.find((source) => source?.storage)?.storage;
  return {
    ...mergedConfig,
    ...(database ? { database } : {}),
    ...(plugins ? { plugins } : {}),
    ...(signing ? { signing } : {}),
    ...(storage ? { storage } : {}),
  };
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

  for (const key of ["authorityId", "catalogId"]) {
    if (config && Object.hasOwn(config, key)) {
      throw new Error(
        `Remove ${key} from hot-updater.config. Catalog identity is managed internally.`,
      );
    }
  }

  if (config && Object.hasOwn(config, "compressStrategy")) {
    throw new Error(
      "Remove compressStrategy from hot-updater.config. OTA artifacts use manifest files with per-file Brotli compression.",
    );
  }

  const mergedConfig = mergeConfigSources(config, getDefaultConfig());
  const signing = normalizeSigningConfig(mergedConfig.signing);
  return {
    ...mergedConfig,
    signing,
  } as ConfigResponse;
};
