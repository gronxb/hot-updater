import path from "path";
import {
  type BasePluginArgs,
  type BuildPlugin,
  type BuildPluginConfig,
  log,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import fs from "fs/promises";
import { resolveMain } from "./resolveMain";

interface RunBundleArgs {
  cwd: string;
  platform: string;
  buildPath: string;
  sourcemap: boolean;
  channel: string;
}

const runBundle = async ({
  cwd,
  platform,
  buildPath,
  sourcemap,
  channel,
}: RunBundleArgs) => {
  const filename = `index.${platform}`;
  const bundleOutput = path.join(buildPath, `${filename}.bundle`);
  const entryFile = resolveMain(cwd);

  const args = [
    "expo",
    "export:embed",
    "--platform",
    platform,
    "--entry-file",
    entryFile,
    "--bundle-output",
    bundleOutput,
    "--dev",
    String(false),
    "--assets-dest",
    buildPath,
    ...(sourcemap ? ["--sourcemap-output", `${bundleOutput}.map`] : []),
  ];

  log.normal("\n");

  try {
    await execa("npx", args, {
      cwd,
      env: {
        ...process.env,
        BUILD_OUT_DIR: buildPath,
        HOT_UPDATER_CHANNEL: channel,
      },
      reject: true,
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
    throw new Error(`If you are using Babel, please check if 'hot-updater/babel-plugin' is configured in babel.config.js
Example:
module.exports = {
  plugins: [
    ["@hot-updater/babel-plugin"]
  ]
}
`);
  }

  return {
    bundleId,
    stdout: null,
  };
};

export interface ExpoPluginConfig extends BuildPluginConfig {
  /**
   * @default false
   * Whether to generate sourcemap for the bundle.
   */
  sourcemap?: boolean;
}

export const expo =
  (config: ExpoPluginConfig = { outDir: "dist", sourcemap: false }) =>
  ({ cwd }: BasePluginArgs): BuildPlugin => {
    const { outDir = "dist", sourcemap = false } = config;
    return {
      build: async ({ platform, channel }) => {
        const buildPath = path.join(cwd, outDir);

        await fs.rm(buildPath, { recursive: true, force: true });
        await fs.mkdir(buildPath, { recursive: true });

        const { bundleId, stdout } = await runBundle({
          cwd,
          platform,
          buildPath,
          sourcemap,
          channel,
        });

        return {
          channel,
          buildPath,
          bundleId,
          stdout,
        };
      },
      name: "expo",
    };
  };
