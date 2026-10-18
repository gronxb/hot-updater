import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { bare } from "@hot-updater/bare";
import { p, readBundleSigningPublicKeyFile } from "@hot-updater/cli-tools";
import type {
  BuildAdapter,
  BuildAdapterArgs,
  BuildAdapterConfig,
  Platform,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";

const PLUGIN_NAMES = new Set([
  "@hot-updater/one",
  "@hot-updater/one/app.plugin.js",
]);

type OnePluginEntry = string | readonly [string, unknown?];

/** The props of the `@hot-updater/one` entry in `native.app.plugins`. */
export type HotUpdaterOnePluginProps = {
  channel?: string;
  publicKeyPath?: string;
};

type OneUserOptions = {
  native?: { app?: { plugins?: readonly OnePluginEntry[] } } | boolean;
};

/**
 * Reads the `@hot-updater/one` entry from `native.app.plugins` in the app's
 * vite config, through One's public `loadUserOneOptions`. Returns `undefined`
 * when the app does not list the plugin, so its native files are patched
 * some other way.
 */
export const readOnePluginProps = async (
  cwd: string,
): Promise<HotUpdaterOnePluginProps | undefined> => {
  const require = createRequire(path.join(cwd, "package.json"));
  type LoadUserOneOptions = (
    command: "build",
    silent?: boolean,
  ) => Promise<{ oneOptions: OneUserOptions }>;
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
  const entry = app?.plugins?.find((plugin) =>
    PLUGIN_NAMES.has(typeof plugin === "string" ? plugin : plugin[0]),
  );
  if (entry === undefined) return undefined;
  const props = typeof entry === "string" ? undefined : entry[1];
  return typeof props === "object" && props !== null
    ? (props as HotUpdaterOnePluginProps)
    : {};
};

const getPublicKeyPath = (props: HotUpdaterOnePluginProps) => {
  const { publicKeyPath } = props;
  if (publicKeyPath === undefined) return undefined;
  if (typeof publicKeyPath !== "string" || !publicKeyPath.trim()) {
    throw new Error("@hot-updater/one publicKeyPath must be a non-empty path.");
  }
  return publicKeyPath;
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
    const props = await readOnePluginProps(cwd);

    return {
      ...adapter,
      name: "one",
      nativeBuild: {
        ...adapter.nativeBuild,
        prebuild: ({ platform }) => runOnePrebuild({ cwd, platform }),
        // Without the plugin, the CLI reads the generated native files instead.
        ...(props === undefined
          ? {}
          : {
              getBundleSigningPublicKey: async () => {
                const publicKeyPath = getPublicKeyPath(props);
                if (publicKeyPath === undefined) return null;
                return {
                  publicKey: await readBundleSigningPublicKeyFile(
                    publicKeyPath,
                    {
                      cwd,
                    },
                  ),
                };
              },
              getFingerprintExtraSources: async () => {
                const publicKeyPath = getPublicKeyPath(props);
                return publicKeyPath === undefined ? [] : [publicKeyPath];
              },
            }),
      },
    };
  };
