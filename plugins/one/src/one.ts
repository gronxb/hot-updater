import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { bare } from "@hot-updater/bare";
import {
  p,
  reactNativeCliFingerprint,
  readBundleSigningPublicKeyFile,
  readGradleFlags,
} from "@hot-updater/cli-tools";
import type {
  BuildAdapter,
  BuildAdapterArgs,
  BuildAdapterConfig,
  NativeFingerprintOptions,
  Platform,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";

import {
  findHotUpdaterPatchesOptions,
  type HotUpdaterPatchesOptions,
} from "./tag";

/** What the build adapter reads from the app's `native.app`. */
export interface OneNativeApp {
  /** The app version `one prebuild` writes, when `native.app` sets one. */
  readonly version?: string;
  /**
   * The options of the `hotUpdaterPatches` in `native.app.patches`, or
   * `undefined` when the app patches its native files some other way.
   */
  readonly hotUpdater?: HotUpdaterPatchesOptions;
}

type OneUserOptions = {
  native?: { app?: { version?: unknown; patches?: unknown } } | boolean;
};

type LoadUserOneOptions = (
  command: "build",
  silent?: boolean,
) => Promise<{ oneOptions: OneUserOptions }>;

/**
 * Reads `native.app` from the app's vite config through One's public
 * `loadUserOneOptions`, as `one prebuild` reads it.
 */
export const readOneNativeApp = async (cwd: string): Promise<OneNativeApp> => {
  const require = createRequire(path.join(cwd, "package.json"));
  // `one/vite` resolves to its CommonJS build here, whose exports may arrive
  // as named exports or under `default`.
  const oneVite = (await import(
    pathToFileURL(require.resolve("one/vite")).href
  )) as {
    loadUserOneOptions?: LoadUserOneOptions;
    default?: { loadUserOneOptions?: LoadUserOneOptions };
  };
  const loadUserOneOptions =
    oneVite.loadUserOneOptions ?? oneVite.default?.loadUserOneOptions;
  if (!loadUserOneOptions) {
    throw new Error(
      "@hot-updater/one needs a One version whose one/vite exports loadUserOneOptions.",
    );
  }

  // One resolves the vite config from the working directory.
  const previousCwd = process.cwd();
  if (previousCwd !== cwd) process.chdir(cwd);
  let oneOptions: OneUserOptions;
  try {
    ({ oneOptions } = await loadUserOneOptions("build", true));
  } finally {
    if (previousCwd !== cwd) process.chdir(previousCwd);
  }

  const app =
    typeof oneOptions.native === "object" ? oneOptions.native.app : undefined;
  const hotUpdater = findHotUpdaterPatchesOptions(app?.patches);
  return {
    ...(typeof app?.version === "string" && app.version
      ? { version: app.version }
      : {}),
    ...(hotUpdater === undefined ? {} : { hotUpdater }),
  };
};

/** Runs `one prebuild`, which regenerates ios/ and android/ from the One config. */
const runOnePrebuild = async ({
  cwd,
  platform,
}: {
  cwd: string;
  platform: Platform;
}) => {
  const spinner = p.spinner();
  spinner.start("Run one prebuild");
  try {
    await execa(
      "npx",
      ["one", "prebuild", "--platform", platform, "--no-install"],
      {
        cwd,
      },
    );
    spinner.stop("One prebuild done");
  } catch (e) {
    spinner.stop("One prebuild failed");
    if (e instanceof ExecaError) {
      p.log.error(e.stderr || e.stdout || e.message);
    } else if (e instanceof Error) {
      p.log.error(e.message);
    }
    process.exit(1);
  }
};

// The folders `one prebuild` skips when it collects an app's own Swift and
// Kotlin sources, at any depth, and the folders it generates.
const ONE_SKIPPED_DIRS =
  "{node_modules,ios,android,dist,types,build,tests,__tests__,scripts,evidence}";

/**
 * The app's own native sources, which `one prebuild` compiles into the app:
 * the Swift packages (a folder with a `Package.swift`) and the Kotlin files
 * outside the generated folders. They have no codegen spec, so their native
 * files are their interface, as a local package's are.
 */
export const ONE_NATIVE_SOURCES: Readonly<Record<Platform, string[]>> = {
  ios: [
    "**/Package.swift",
    "**/*.swift",
    `!**/${ONE_SKIPPED_DIRS}/**`,
    "!**/.*/**",
  ],
  android: ["**/*.kt", `!**/${ONE_SKIPPED_DIRS}/**`, "!**/.*/**"],
};

/**
 * The engine settings `one prebuild` writes into android/gradle.properties:
 * those of React Native's community template, which it copies unchanged.
 * Undefined when the template can't be resolved, so the native project's
 * own file counts.
 */
const readOneGradleFlags = async (cwd: string) => {
  try {
    const template = createRequire(path.join(cwd, "package.json")).resolve(
      "@react-native-community/template/template/package.json",
    );
    return await readGradleFlags(path.join(path.dirname(template), "android"));
  } catch {
    return undefined;
  }
};

/**
 * One's native fingerprint: bare's interface fingerprint, since One bundles
 * and links like bare, plus the app's own Swift and Kotlin sources. It reads
 * no file `one prebuild` generates, so `fingerprint create` before prebuild
 * and the native build after it compute the same one. A native build computes
 * it from the inputs fingerprint.json records.
 */
export const oneFingerprint = async (
  cwd: string,
  options: NativeFingerprintOptions,
) => {
  const { extraSources, platform } = options;
  const own = Array.isArray(extraSources)
    ? extraSources
    : (extraSources?.[platform] ?? []);
  return reactNativeCliFingerprint(
    cwd,
    { ...options, extraSources: [...own, ...ONE_NATIVE_SOURCES[platform]] },
    platform === "android" ? await readOneGradleFlags(cwd) : undefined,
  );
};

export interface OneAdapterConfig extends BuildAdapterConfig {
  /**
   * @default false
   * Whether to generate sourcemap for the bundle.
   */
  sourcemap?: boolean;
  /**
   * @default true
   * Whether to reset One's transform cache before bundling.
   */
  resetCache?: boolean;
}

/**
 * Builds a One app's bundle with `react-native bundle`, which One's
 * `react-native.config.cjs` routes through its own bundler, and compiles it
 * with Hermes, which One apps always use.
 */
export const one =
  (config: OneAdapterConfig = {}) =>
  async ({ cwd }: BuildAdapterArgs): Promise<BuildAdapter> => {
    const {
      // One's native bundle step writes files into dist/, beside the web build.
      outDir = path.join("node_modules", ".hot-updater", "build"),
      sourcemap = false,
      resetCache = true,
    } = config;
    const adapter = bare({ enableHermes: true, outDir, sourcemap, resetCache })(
      {
        cwd,
      },
    );
    const app = await readOneNativeApp(cwd);
    const props = app.hotUpdater;
    const publicKeyPath = props?.publicKeyPath;

    return {
      ...adapter,
      name: "one",
      nativeBuild: {
        ...adapter.nativeBuild,
        fingerprint: (options) => oneFingerprint(cwd, options),
        getNativeProjectValues: async () => ({
          ...(app.version === undefined ? {} : { appVersion: app.version }),
          ...(props === undefined
            ? {}
            : { channel: props.channel || "production" }),
          ...(publicKeyPath === undefined ? {} : { publicKeyPath }),
        }),
        prebuild: ({ platform }) => runOnePrebuild({ cwd, platform }),
        // Without hotUpdaterPatches, the CLI reads the generated native files.
        ...(props === undefined
          ? {}
          : {
              getBundleSigningPublicKey: async () =>
                publicKeyPath === undefined
                  ? null
                  : {
                      publicKey: await readBundleSigningPublicKeyFile(
                        publicKeyPath,
                        { cwd },
                      ),
                    },
              getFingerprintExtraSources: async () =>
                publicKeyPath === undefined ? [] : [publicKeyPath],
            }),
      },
    };
  };
