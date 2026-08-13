import path from "path";

import type {
  ConfigInput,
  Platform,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  createStoragePlugin,
} from "@hot-updater/plugin-core";
import { merge } from "es-toolkit";
import fg from "fast-glob";
import { type LoadConfigOptions, loadConfig as loadUnconfig } from "unconfig";

import { getCwd } from "./cwd.js";

export type HotUpdaterConfigOptions = {
  platform: Platform;
  channel: string;
} | null;

const missingDatabase = createDatabasePlugin({
  name: "missingDatabase",
  models: {
    bundles: {
      findById: async () => {
        throw new Error("database plugin is required");
      },
      findMany: async () => {
        throw new Error("database plugin is required");
      },
      count: async () => {
        throw new Error("database plugin is required");
      },
    },
    bundlePatches: {
      findByBundleIds: async () => {
        throw new Error("database plugin is required");
      },
    },
    releases: {
      findById: async () => {
        throw new Error("database plugin is required");
      },
      findMany: async () => {
        throw new Error("database plugin is required");
      },
      findManyByScope: async () => {
        throw new Error("database plugin is required");
      },
    },
    releaseCatalogs: {
      findByScopeKey: async () => {
        throw new Error("database plugin is required");
      },
      findMany: async () => {
        throw new Error("database plugin is required");
      },
    },
    channels: {
      insert: async () => {
        throw new Error("database plugin is required");
      },
      list: async () => {
        throw new Error("database plugin is required");
      },
      delete: async () => {
        throw new Error("database plugin is required");
      },
    },
    analytics: {
      append: async () => {
        throw new Error("database plugin is required");
      },
      scan: async () => {
        throw new Error("database plugin is required");
      },
    },
    clientAccessKeys: {
      create: async () => {
        throw new Error("database plugin is required");
      },
      findByHash: async () => {
        throw new Error("database plugin is required");
      },
      list: async () => {
        throw new Error("database plugin is required");
      },
      revoke: async () => {
        throw new Error("database plugin is required");
      },
    },
  },
  commit: async () => {
    throw new Error("database plugin is required");
  },
});

const missingStorageError = async (): Promise<never> => {
  throw new Error("storage plugin is required");
};

const missingStorage = createStoragePlugin({
  name: "missingStorage",
  protocol: "missing",
  put: missingStorageError,
  get: missingStorageError,
  exists: missingStorageError,
  delete: missingStorageError,
});

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
      androidManifestPaths,
      stringResourcePaths,
    },
    ios: {
      infoPlistPaths,
    },
  };
};

const getDefaultConfig = (): ConfigInput => {
  return {
    authorityId: "default",
    cacheDir: path.join("node_modules", ".hot-updater"),
    releaseChannel: "production",
    updateStrategy: "appVersion",
    compressStrategy: "zip",
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
      throw new Error("build plugin is required");
    },
    storage: missingStorage,
    database: missingDatabase,
  };
};

export type ConfigResponse = RequiredDeep<
  Omit<ConfigInput, "database" | "storage">
> &
  Pick<ConfigInput, "database" | "storage">;

const mergeConfigSources = (
  ...sources: Array<ConfigInput | null | undefined>
) => {
  const mergedConfig = sources.reduceRight<ConfigInput>(
    (mergedConfig, source) => merge(mergedConfig, source ?? {}),
    {} as ConfigInput,
  );

  const database = sources.find((source) => source?.database)?.database;
  const storage = sources.find((source) => source?.storage)?.storage;
  return {
    ...mergedConfig,
    ...(database ? { database } : {}),
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

  return mergeConfigSources(config, getDefaultConfig()) as ConfigResponse;
};
