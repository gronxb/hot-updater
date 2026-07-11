import path from "path";

import type {
  ConfigInput,
  DatabasePluginHandle,
  MaybePromise,
  Platform,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import type { DatabasePluginRuntime } from "@hot-updater/plugin-core/internal";
import { merge } from "es-toolkit";
import fg from "fast-glob";
import { type LoadConfigOptions, loadConfig as loadUnconfig } from "unconfig";

import { getCwd } from "./cwd.js";

export type HotUpdaterConfigOptions = {
  platform: Platform;
  channel: string;
} | null;

export type LoadedDatabaseConfig = () => MaybePromise<DatabasePluginRuntime>;

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

export type ConfigResponse = Omit<RequiredDeep<ConfigInput>, "database"> & {
  database: LoadedDatabaseConfig;
};

const databaseRuntimeFactorySymbol = Symbol.for(
  "@hot-updater/plugin-core/database-runtime-factory",
);
const loadedDatabaseDisposerSymbol = Symbol.for(
  "@hot-updater/cli-tools/database-disposer",
);
const databaseOwnerDisposePromises = new WeakMap<object, Promise<void>>();

type DatabaseRuntimeOrHandle = DatabasePluginRuntime | DatabasePluginHandle;

type DatabaseRuntimeOrHandleWithFactory = DatabaseRuntimeOrHandle & {
  readonly [databaseRuntimeFactorySymbol]?: LoadedDatabaseConfig;
};

type DatabaseOwnerWithClose = DatabaseRuntimeOrHandleWithFactory & {
  readonly close: () => MaybePromise<void>;
};

const mergeConfigSources = (
  ...sources: Array<ConfigInput | null | undefined>
) => {
  const mergedConfig = sources.reduceRight<ConfigInput>(
    (mergedConfig, source) => merge(mergedConfig, source ?? {}),
    {} as ConfigInput,
  );
  const databaseConfig = sources.find(
    (source) => source?.database !== undefined,
  )?.database;

  return databaseConfig === undefined
    ? mergedConfig
    : { ...mergedConfig, database: databaseConfig };
};

const isDatabasePluginRuntime = (
  database: DatabaseRuntimeOrHandle,
): database is DatabasePluginRuntime =>
  "bundles" in database && "bundlePatches" in database && "commit" in database;

const hasDatabaseClose = (
  database: DatabaseRuntimeOrHandleWithFactory,
): database is DatabaseOwnerWithClose =>
  "close" in database && typeof database.close === "function";

const disposeDatabaseOwner = (
  database: DatabaseRuntimeOrHandleWithFactory,
): Promise<void> => {
  const existingDispose = databaseOwnerDisposePromises.get(database);
  if (existingDispose) {
    return existingDispose;
  }

  if (!hasDatabaseClose(database)) {
    return Promise.resolve();
  }

  const dispose = Promise.resolve().then(() => database.close());
  databaseOwnerDisposePromises.set(database, dispose);
  return dispose;
};

const openRuntime = async (
  database: DatabaseRuntimeOrHandleWithFactory,
): Promise<DatabasePluginRuntime> => {
  const openDatabaseRuntime = database[databaseRuntimeFactorySymbol];
  const runtime = openDatabaseRuntime
    ? await openDatabaseRuntime()
    : isDatabasePluginRuntime(database)
      ? database
      : null;

  if (!runtime) {
    throw new Error("Database config could not be opened as a runtime plugin.");
  }

  Object.defineProperty(runtime, loadedDatabaseDisposerSymbol, {
    configurable: true,
    enumerable: false,
    value: () => disposeDatabaseOwner(database),
  });
  return runtime;
};

export const disposeLoadedDatabase = async (
  database: DatabasePluginRuntime,
): Promise<void> => {
  const dispose: unknown = Reflect.get(database, loadedDatabaseDisposerSymbol);
  if (typeof dispose === "function") {
    await dispose();
    return;
  }
  await disposeDatabaseOwner(database);
};

const normalizeDatabaseConfig = (
  database: RequiredDeep<ConfigInput>["database"],
): LoadedDatabaseConfig => {
  if (typeof database === "function") {
    return () =>
      Promise.resolve(database()).then((runtime) => openRuntime(runtime));
  }

  return () =>
    Promise.resolve(database).then((runtime) => openRuntime(runtime));
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

  const mergedConfig = mergeConfigSources(
    config,
    getDefaultConfig(),
  ) as RequiredDeep<ConfigInput>;

  return {
    ...mergedConfig,
    database: normalizeDatabaseConfig(mergedConfig.database),
  } as ConfigResponse;
};
