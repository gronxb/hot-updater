import path from "path";

import type {
  AnyHotUpdaterPlugin,
  ConfigInput,
  ConfiguredDatabase,
  Platform,
  RequiredDeep,
  SecretsAdapter,
  StorageAdapter,
} from "@hot-updater/plugin-core";
import { mergeWith } from "es-toolkit";
import fg from "fast-glob";
import { type LoadConfigOptions, loadConfig as loadUnconfig } from "unconfig";

import { getCwd } from "./cwd.js";
import { normalizeSigningConfig } from "./localBundleSigning.js";
import {
  type SecretsScope,
  setConfiguredSecrets,
  withLocalKeyStore,
  withSecretsScope,
} from "./secrets.js";

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
  Omit<ConfigInput, "database" | "storage" | "plugins" | "signing" | "secrets">
> & {
  /** The server's database, or `standaloneRepository(...)`; absent when the config names none. */
  database?: ConfiguredDatabase;
  /** Where the CLI uploads bundles; absent when the config names none. */
  storage?: StorageAdapter;
  /** The plugins the server runs; none when the config lists none. */
  plugins: readonly AnyHotUpdaterPlugin[];
  signing?: ReturnType<typeof normalizeSigningConfig>;
  /**
   * Where `secret:` references and issued keys are read and stored: the
   * config's adapter with `local()`'s store after it (`withLocalKeyStore`),
   * or `local()` when it sets none.
   */
  secrets: SecretsAdapter;
};

type ConfigSource = Partial<ConfigInput> | null | undefined;

/**
 * An array in the config replaces the default one. A plain deep merge goes
 * index by index, so `infoPlistPaths: ["ios/App/Info.plist"]` over three
 * discovered Info.plist files only overwrote the first and kept the others.
 * The array is still copied deeply, as `merge` copied it.
 */
const replaceArrays = (_targetValue: unknown, sourceValue: unknown): unknown =>
  Array.isArray(sourceValue)
    ? mergeWith([], sourceValue, replaceArrays)
    : undefined;

const mergeConfigSources = (...sources: ConfigSource[]) => {
  const mergedConfig = sources.reduceRight<Partial<ConfigInput>>(
    (mergedConfig, source) =>
      mergeWith(mergedConfig, source ?? {}, replaceArrays),
    {},
  );

  // Taken whole, as the config made them: a deep merge copies objects
  // without their symbol keys, such as the brand on Hot Updater's own plugins.
  const database = sources.find((source) => source?.database)?.database;
  const plugins = sources.find((source) => source?.plugins)?.plugins;
  const secrets = sources.find((source) => source?.secrets)?.secrets;
  const signing = sources.find((source) => source?.signing)?.signing;
  const storage = sources.find((source) => source?.storage)?.storage;
  return {
    ...mergedConfig,
    ...(database ? { database } : {}),
    ...(plugins ? { plugins } : {}),
    ...(secrets ? { secrets } : {}),
    ...(signing ? { signing } : {}),
    ...(storage ? { storage } : {}),
  };
};

/** What hot-updater.config exports: the config, or a function of the platform and channel that returns it. */
type ConfigFileExport =
  | ConfigInput
  | ((options: HotUpdaterConfigOptions) => ConfigInput | Promise<ConfigInput>);

const getConfigLoaderOptions = (): LoadConfigOptions<ConfigFileExport> => {
  const cwd = getCwd();

  return {
    cwd,
    stopAt: path.dirname(cwd),
    merge: false,
    sources: [
      {
        files: "hot-updater.config",
        extensions: ["js", "cjs", "ts", "cts", "mjs", "mts"],
      },
    ],
  };
};

/** A loaded config file: its export, and the scope of the `secretEnv` its top level creates. */
type LoadedConfigFile = {
  readonly source: ConfigFileExport | undefined;
  readonly scope: SecretsScope;
};

/** Each load runs the config file again, which creates its adapters again. */
const loadConfigFile = async (): Promise<LoadedConfigFile> => {
  const scope: SecretsScope = {};
  const { config } = await withSecretsScope(scope, () =>
    loadUnconfig<ConfigFileExport>(getConfigLoaderOptions()),
  );
  return { source: config, scope };
};

/**
 * The config `options` select, resolved: a config function runs in a scope
 * of its own, so the `secretEnv` it creates reads this config's `secrets`,
 * and the file's top-level `secretEnv` reads the first config's.
 */
const configFor = async (
  { source, scope: fileScope }: LoadedConfigFile,
  options: HotUpdaterConfigOptions,
): Promise<ConfigResponse> => {
  if (typeof source !== "function") {
    return resolveConfig(source, [fileScope]);
  }
  const scope: SecretsScope = {};
  const config = await withSecretsScope(scope, () => source(options));
  return resolveConfig(config, [scope, fileScope]);
};

export const loadConfig = async (
  options: HotUpdaterConfigOptions,
): Promise<ConfigResponse> => configFor(await loadConfigFile(), options);

/**
 * hot-updater.config for each of `platforms`, with the file loaded once. A
 * config object gives every platform the same database, storage, and
 * plugins; a config function runs once per platform, so the adapters it
 * creates are that platform's own.
 */
export const loadPlatformConfigs = async <TPlatform extends Platform>(
  platforms: readonly TPlatform[],
  { channel }: { readonly channel: string },
): Promise<
  { readonly platform: TPlatform; readonly config: ConfigResponse }[]
> => {
  const file = await loadConfigFile();
  const configs: { platform: TPlatform; config: ConfigResponse }[] = [];
  for (const platform of platforms) {
    configs.push({
      platform,
      config: await configFor(file, { channel, platform }),
    });
  }
  return configs;
};

/**
 * The config with its defaults. Its `secrets` adapter fills `scopes` not yet
 * filled, which the `secretEnv` its evaluation created read, and becomes the
 * default of credential resolvers.
 */
const resolveConfig = (
  config: ConfigInput | undefined,
  scopes: readonly SecretsScope[],
): ConfigResponse => {
  const mergedConfig = mergeConfigSources(config, getDefaultConfig());
  const secrets = withLocalKeyStore(mergedConfig.secrets);
  const signing = normalizeSigningConfig(mergedConfig.signing, { secrets });
  for (const scope of scopes) scope.secrets ??= secrets;
  setConfiguredSecrets(secrets);
  return {
    ...mergedConfig,
    signing,
    secrets,
  } as ConfigResponse;
};
