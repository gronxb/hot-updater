import path from "path";
import {
  type BasePluginArgs,
  type BuildPlugin,
  type BuildPluginConfig,
  log,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import fs from "fs/promises";

interface RunBundleArgs {
  entryFile: string;
  cwd: string;
  platform: string;
  buildPath: string;
  sourcemap: boolean;
  hermes: boolean;
  channel: string;
}

const runBundle = async ({
  entryFile,
  cwd,
  platform,
  buildPath,
  sourcemap,
  hermes,
  channel,
}: RunBundleArgs) => {
  const args = [
    "rnef",
    "bundle",
    "--entry-file",
    entryFile,
    "--platform",
    platform,
    ...(hermes ? ["--hermes"] : []),
    "--bundle-output",
    path.join(buildPath, `index.${platform}.bundle`),
    ...(sourcemap
      ? ["--sourcemap-output", path.join(buildPath, `index.${platform}.map`)]
      : []),
  ];

  log.normal("\n");
  try {
    await execa("npx", args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        BUILD_OUT_DIR: buildPath,
        HOT_UPDATER_CHANNEL: channel,
      },
    });
  } catch (error) {
    if (error instanceof ExecaError) {
      throw error.stderr;
    }
  }

  const bundleId = await fs
    .readFile(path.join(buildPath, "BUNDLE_ID"), "utf-8")
    .catch(() => null);

  if (!bundleId) {
    throw new Error(`Please check if 'hot-updater/babel-plugin' is configured in babel.config.js
Example:
{
  plugins: ['hot-updater/babel-plugin']
}`);
  }

  return {
    bundleId,
    stdout: null,
  };
};

export interface RnefPluginConfig extends BuildPluginConfig {
  /**
   * @default "index.js"
   * The entry file to bundle.
   */
  entryFile?: string;
  /**
   * @default false
   * Whether to generate sourcemap for the bundle.
   */
  sourcemap?: boolean;
  /**
   * Whether to use Hermes to compile the bundle
   * Since React Native v0.70+, Hermes is enabled by default, so it's recommended to enable it.
   * @default true
   */
  hermes?: boolean;
}

export const rnef =
  (
    config: RnefPluginConfig = {
      outDir: "dist",
      sourcemap: false,
      entryFile: "index.js",
      hermes: true,
    },
  ) =>
  ({ cwd }: BasePluginArgs): BuildPlugin => {
    const {
      outDir = "dist",
      sourcemap = false,
      entryFile = "index.js",
      hermes = true,
    } = config;
    return {
      build: async ({ platform, channel }) => {
        const buildPath = path.join(cwd, outDir);

        await fs.rm(buildPath, { recursive: true, force: true });
        await fs.mkdir(buildPath, { recursive: true });

        const { bundleId, stdout } = await runBundle({
          entryFile,
          cwd,
          platform,
          buildPath,
          sourcemap,
          channel,
          hermes,
        });

        return {
          channel,
          buildPath,
          bundleId,
          stdout,
        };
      },
      name: "rnef",
    };
  };
