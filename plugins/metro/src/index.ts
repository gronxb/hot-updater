import path from "path";
import {
  type BasePluginArgs,
  type BuildPlugin,
  type BuildPluginConfig,
  log,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import fs from "fs/promises";
import { compileHermes } from "./hermes";

interface RunBundleArgs {
  entryFile: string;
  cwd: string;
  platform: string;
  buildPath: string;
  sourcemap: boolean;
  useHermes: boolean;
}

const runBundle = async ({
  entryFile,
  cwd,
  platform,
  buildPath,
  sourcemap,
  useHermes,
}: RunBundleArgs) => {
  const reactNativePath = require.resolve("react-native");
  const cliPath = path.resolve(reactNativePath, "..", "cli.js");

  const filename = `index.${platform}`;
  const bundleOutput = path.join(buildPath, `${filename}.bundle`);

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
    ...(sourcemap ? ["--sourcemap-output", `${bundleOutput}.map`] : []),
    "--reset-cache",
  ];

  log.normal("\n");

  try {
    await execa(cliPath, args, {
      cwd,
      env: {
        ...process.env,
        BUILD_OUT_DIR: buildPath,
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

  if (useHermes) {
    const hbcFile = await compileHermes({
      outputHbcFile: bundleOutput,
      inputJsFile: bundleOutput,
      sourcemapOutput: sourcemap ? `${bundleOutput}.map` : undefined,
    });

    console.log("hbcFile", hbcFile);
  }

  return bundleId;
};

export interface MetroPluginConfig extends BuildPluginConfig {
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
   * Whether to use Hermes to compile the bundle.
   * @default false
   */
  useHermes?: boolean;
}

export const metro =
  (
    config: MetroPluginConfig = {
      entryFile: "index.js",
      outDir: "dist",
      sourcemap: false,
    },
  ) =>
  ({ cwd }: BasePluginArgs): BuildPlugin => {
    const {
      outDir = "dist",
      sourcemap = false,
      entryFile = "index.js",
      useHermes = false,
    } = config;
    return {
      build: async ({ platform }) => {
        const buildPath = path.join(cwd, outDir);

        await fs.rm(buildPath, { recursive: true, force: true });
        await fs.mkdir(buildPath, { recursive: true });

        const bundleId = await runBundle({
          entryFile,
          cwd,
          platform,
          buildPath,
          sourcemap,
          useHermes,
        });

        return {
          buildPath,
          bundleId,
        };
      },
      name: "metro",
    };
  };
