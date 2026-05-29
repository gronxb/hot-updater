import fs from "fs/promises";
import path from "path";

import { log } from "@hot-updater/cli-tools";
import type {
  BasePluginArgs,
  BuildPlugin,
  BuildPluginConfig,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import { uuidv7 } from "uuidv7";

import { compileHermes } from "./hermes";

interface RunBundleArgs {
  entryFile: string;
  cwd: string;
  platform: string;
  buildPath: string;
  sourcemap: boolean;
  enableHermes: boolean;
  resetCache: boolean;
}

const runBundle = async ({
  entryFile,
  cwd,
  platform,
  buildPath,
  sourcemap,
  enableHermes,
  resetCache,
}: RunBundleArgs) => {
  const reactNativePath = require.resolve("react-native/package.json", {
    paths: [cwd],
  });
  const cliPath = path.join(path.dirname(reactNativePath), "cli.js");

  const filename = `index.${platform}`;
  const bundleOutput = path.join(buildPath, `${filename}.bundle`);
  const bundleId = uuidv7();

  const args = [
    "bundle",
    "--assets-dest",
    buildPath,
    "--bundle-output",
    bundleOutput,
    "--dev",
    String(false),
    "--entry-file",
    entryFile,
    "--platform",
    platform,
    // disable minify when enableHermes is true
    "--minify",
    String(!enableHermes),
    ...(sourcemap ? ["--sourcemap-output", `${bundleOutput}.map`] : []),
    ...(resetCache ? ["--reset-cache"] : []),
  ];

  log.normal("\n");

  try {
    await execa(cliPath, args, {
      cwd,
      reject: true,
    });
  } catch (error) {
    if (error instanceof ExecaError) {
      throw error.stderr;
    }
  }

  if (enableHermes) {
    const { hermesVersion } = await compileHermes({
      cwd,
      inputJsFile: bundleOutput,
      sourcemap,
    });

    return {
      bundleId,
      stdout: hermesVersion,
    };
  }

  return {
    bundleId,
    stdout: null,
  };
};

export interface BarePluginConfig extends BuildPluginConfig {
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
   * @link https://reactnative.dev/docs/hermes
   * @recommended true
   */
  enableHermes: boolean;
  /**
   * @default true
   * Whether to reset the Metro cache before bundling.
   */
  resetCache?: boolean;
}

export const bare =
  (config: BarePluginConfig) =>
  ({ cwd }: BasePluginArgs): BuildPlugin => {
    const {
      outDir = "dist",
      sourcemap = false,
      entryFile = "index.js",
      enableHermes,
      resetCache = true,
    } = config;
    return {
      build: async ({ platform }) => {
        const buildPath = path.join(cwd, outDir);

        await fs.rm(buildPath, { recursive: true, force: true });
        await fs.mkdir(buildPath, { recursive: true });

        const { bundleId, stdout } = await runBundle({
          entryFile,
          cwd,
          platform,
          buildPath,
          sourcemap,
          enableHermes,
          resetCache,
        });

        return {
          buildPath,
          bundleId,
          stdout,
        };
      },
      name: "bare",
    };
  };
