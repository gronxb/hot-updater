import path from "path";

import type {
  ConfigInput,
  Platform,
  RemoteServer,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import { isRemoteServer } from "@hot-updater/plugin-core";
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

const getDefaultConfig = (): Omit<ConfigInput, "server"> => {
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
  };
};

export type ConfigResponse = RequiredDeep<
  Omit<ConfigInput, "server" | "signing">
> & {
  /**
   * The absolute path of the server definition, or the self-hosted server
   * the CLI reaches through its admin API; absent when the config names
   * none.
   */
  server?: string | RemoteServer;
  signing?: ReturnType<typeof normalizeSigningConfig>;
};

type ConfigSource = Partial<ConfigInput> | null | undefined;

const mergeConfigSources = (...sources: ConfigSource[]) => {
  const mergedConfig = sources.reduceRight<Partial<ConfigInput>>(
    (mergedConfig, source) => merge(mergedConfig, source ?? {}),
    {},
  );

  const signing = sources.find((source) => source?.signing)?.signing;
  return {
    ...mergedConfig,
    ...(signing ? { signing } : {}),
  };
};

/**
 * The config's `server`: a path, resolved against the config file's
 * directory, or a remote server, which is taken whole.
 */
const resolveServer = (
  server: unknown,
  configFile: string | undefined,
): string | RemoteServer | undefined => {
  if (server === undefined) return undefined;
  if (typeof server === "string" && server.trim() !== "") {
    return path.resolve(
      configFile === undefined ? getCwd() : path.dirname(configFile),
      server,
    );
  }
  if (isRemoteServer(server)) return server;
  throw new Error(
    "server in hot-updater.config must be the path to your server definition, such as \"./src/hotUpdater.ts\", or standaloneRepository(...).",
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
  const { config, sources } = await loadUnconfig<ConfigInput>(
    getConfigLoaderOptions(options),
  );

  for (const key of ["database", "storage", "plugins"]) {
    if (config && Object.hasOwn(config, key)) {
      throw new Error(
        `Remove ${key} from hot-updater.config: the server definition holds the database, storage, and plugins. Export \`hotUpdater = createHotUpdater({ database, storage, plugins })\` from a module and set \`server\` to its path, or set \`server\` to standaloneRepository({ baseUrl, storage }).`,
      );
    }
  }

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

  const { server, ...mergedConfig } = mergeConfigSources(
    config,
    getDefaultConfig(),
  );
  const signing = normalizeSigningConfig(mergedConfig.signing);
  const resolvedServer = resolveServer(
    config?.server ?? server,
    sources[0],
  );
  return {
    ...mergedConfig,
    ...(resolvedServer === undefined ? {} : { server: resolvedServer }),
    signing,
  } as ConfigResponse;
};
