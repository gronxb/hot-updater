import path from "path";

import type {
  AnyHotUpdaterPlugin,
  ConfigInput,
  ConfiguredDatabase,
  NativeBuildAndroidScheme,
  NativeBuildIosScheme,
  Platform,
  RequiredDeep,
  SecretsAdapter,
  SigningConfig,
  StorageAdapter,
} from "@hot-updater/plugin-core";
import {
  isConfigurableSandboxUrlScheme,
  sandboxUrlSchemeOf,
} from "@hot-updater/protocol/native-artifact";
import { mergeWith } from "es-toolkit";
import fg from "fast-glob";
import { type LoadConfigOptions, loadConfig as loadUnconfig } from "unconfig";

import { bundleSigningSecretRef } from "./bundleSigning.js";
import { getCwd } from "./cwd.js";
import {
  isSecretRef,
  type SecretsScope,
  setConfiguredSecrets,
  resolveSecretsAdapter,
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

/**
 * A scheme's `sandbox` as the CLI reads it: whether the build is a sandbox
 * build, and the URL scheme it registers, the configured `urlScheme` or the
 * one derived from the app's ID, or null for a build of no sandbox. A loaded
 * config sets both.
 */
export interface ResolvedSandbox {
  sandbox?: boolean;
  sandboxUrlScheme?: string | null;
}

/** An iOS `nativeBuild` scheme with its `sandbox` resolved. */
export type ResolvedNativeBuildIosScheme = Omit<
  NativeBuildIosScheme,
  "sandbox"
> &
  ResolvedSandbox;

/** An Android `nativeBuild` scheme with its `sandbox` resolved. */
export type ResolvedNativeBuildAndroidScheme = Omit<
  NativeBuildAndroidScheme,
  "sandbox"
> &
  ResolvedSandbox;

export type ConfigResponse = RequiredDeep<
  Omit<
    ConfigInput,
    "database" | "storage" | "plugins" | "signing" | "secrets" | "nativeBuild"
  >
> & {
  nativeBuild: {
    android: Record<string, RequiredDeep<ResolvedNativeBuildAndroidScheme>>;
    ios: Record<string, RequiredDeep<ResolvedNativeBuildIosScheme>>;
  };
  /** The server's database, or `standaloneRepository(...)`; absent when the config names none. */
  database?: ConfiguredDatabase;
  /** Where the CLI uploads bundles; absent when the config names none. */
  storage?: StorageAdapter;
  /** The plugins the server runs; none when the config lists none. */
  plugins: readonly AnyHotUpdaterPlugin[];
  /**
   * As the config sets it, read only when a command signs: deploy refuses a
   * value it doesn't take (`readBundleSigningState`), and other commands,
   * such as the `secrets put` that fixes it, still load the config.
   */
  signing?: SigningConfig;
  /**
   * Where `secret()` references and issued keys are read and stored: the
   * config's adapter alone, or `localSecrets()` when it sets none
   * (`resolveSecretsAdapter`).
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

/** A loaded config file: its export, and the scope of the `secret()` its top level creates. */
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
 * of its own, so the `secret()` it creates reads this config's `secrets`,
 * and the file's top-level `secret()` reads the first config's.
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
 * The names the config's build credentials reference, which the CLI reads
 * for their kind: `signing`'s, and each scheme's
 * `signing.ascApiKey` and `signing.keystore`.
 */
const buildSecretNames = (config: Partial<ConfigInput>): string[] => {
  const references: unknown[] = [
    bundleSigningSecretRef(config.signing),
    ...Object.values(config.nativeBuild?.ios ?? {}).map(
      (scheme) => scheme?.signing?.ascApiKey,
    ),
    ...Object.values(config.nativeBuild?.android ?? {}).map(
      (scheme) => scheme?.signing?.keystore,
    ),
  ];
  return references.filter(isSecretRef).map(({ name }) => name);
};

/**
 * `sandbox` of the scheme `name` resolved: `true` or an object turns it on,
 * and its URL scheme is `urlScheme`, or the one derived from `appId`. A
 * `urlScheme` no sandbox can register stops the config from loading.
 */
const resolveSandbox = (
  sandbox: NativeBuildIosScheme["sandbox"] | undefined,
  appId: string | undefined,
  name: string,
): Required<ResolvedSandbox> => {
  if (sandbox !== true && (typeof sandbox !== "object" || sandbox === null)) {
    return { sandbox: false, sandboxUrlScheme: null };
  }
  const urlScheme = sandbox === true ? undefined : sandbox.urlScheme;
  if (urlScheme === undefined) {
    return {
      sandbox: true,
      sandboxUrlScheme: appId ? sandboxUrlSchemeOf(appId) : null,
    };
  }
  if (
    typeof urlScheme !== "string" ||
    !isConfigurableSandboxUrlScheme(urlScheme)
  ) {
    throw new Error(
      `${name}: sandbox.urlScheme ${JSON.stringify(urlScheme)} isn't a URL scheme a sandbox build can register.\nUse lower case: a letter, then up to 63 letters, digits, +, . or -, and not http, https, file, data or javascript.`,
    );
  }
  return { sandbox: true, sandboxUrlScheme: urlScheme };
};

/** The config's `nativeBuild` with each scheme's `sandbox` resolved. */
const resolveNativeBuild = (
  nativeBuild: ConfigInput["nativeBuild"],
): ConfigResponse["nativeBuild"] => {
  const resolveSchemes = <T extends { sandbox?: unknown }>(
    schemes: Record<string, T> | undefined,
    platform: Platform,
    appIdOf: (scheme: T) => string | undefined,
  ) =>
    Object.fromEntries(
      Object.entries(schemes ?? {}).map(([name, scheme]) => [
        name,
        scheme
          ? {
              ...scheme,
              ...resolveSandbox(
                scheme.sandbox as NativeBuildIosScheme["sandbox"],
                appIdOf(scheme),
                `nativeBuild.${platform}.${name}`,
              ),
            }
          : scheme,
      ]),
    );
  return {
    ...nativeBuild,
    android: resolveSchemes(
      nativeBuild?.android,
      "android",
      (scheme) => scheme.packageName,
    ),
    ios: resolveSchemes(
      nativeBuild?.ios,
      "ios",
      (scheme) => scheme.bundleIdentifier,
    ),
  } as ConfigResponse["nativeBuild"];
};

/**
 * The config with its defaults. Its `secrets` adapter fills `scopes` not yet
 * filled, which the `secret()` its evaluation created read, and becomes the
 * default of credential resolvers.
 */
const resolveConfig = (
  config: ConfigInput | undefined,
  scopes: readonly SecretsScope[],
): ConfigResponse => {
  const mergedConfig = mergeConfigSources(config, getDefaultConfig());
  const secrets = resolveSecretsAdapter(mergedConfig.secrets);
  const buildNames = buildSecretNames(mergedConfig);
  for (const scope of scopes) {
    scope.secrets ??= secrets;
    scope.buildNames ??= new Set();
    for (const name of buildNames) scope.buildNames.add(name);
  }
  setConfiguredSecrets(secrets);
  const resolved = {
    ...mergedConfig,
    nativeBuild: resolveNativeBuild(mergedConfig.nativeBuild),
    secrets,
  } as ConfigResponse;
  Object.defineProperty(resolved, DEPLOY_SECRET_NAMES, {
    value: [
      ...new Set(scopes.flatMap((scope) => [...(scope.names ?? [])])),
    ].filter((name) => !buildNames.includes(name)),
  });
  return resolved;
};

/**
 * The names the config's build credentials reference, such as
 * `release-keystore`, which builds read from the `secrets` adapter for their
 * kind: `signing`'s, and each scheme's `signing.ascApiKey` and
 * `signing.keystore`.
 */
export const getBuildSecretNames = (
  config: ConfigResponse,
): readonly string[] => [...new Set(buildSecretNames(config))];

const DEPLOY_SECRET_NAMES = Symbol.for(
  "@hot-updater/cli-tools/deploy-secret-names",
);

/**
 * The names the config's `secret()`s reference for its adapters, such as
 * `HOT_UPDATER_CLOUDFLARE_API_TOKEN`, in the order the config created
 * them: every name but those of build credentials, which `doctor` lists
 * by field.
 */
export const getDeploySecretNames = (
  config: ConfigResponse,
): readonly string[] => {
  const names: unknown = Reflect.get(config, DEPLOY_SECRET_NAMES);
  return Array.isArray(names) ? names : [];
};
