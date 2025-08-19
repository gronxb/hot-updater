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
}

const runBundle = async ({
  entryFile,
  cwd,
  platform,
  buildPath,
  sourcemap,
  hermes,
}: RunBundleArgs) => {
  const filename = `index.${platform}`;
  const bundleOutput = path.join(buildPath, `${filename}.bundle`);

  const args = [
    "rock",
    "bundle",
    "--entry-file",
    entryFile,
    "--platform",
    platform,
    ...(hermes ? ["--hermes"] : []),
    "--bundle-output",
    bundleOutput,
    ...(sourcemap ? ["--sourcemap-output", `${bundleOutput}.map`] : []),
    "--assets-dest",
    buildPath,
    "--dev",
    String(false),
  ];

  log.normal("\n");

  let stdout: string | null = null;
  try {
    const result = await execa("npx", args, {
      cwd,
      env: {
        ...process.env,
        BUILD_OUT_DIR: buildPath,
      },
      reject: true,
    });
    stdout = result.stdout;
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
  

If you are using Repack, please check if '@hot-updater/repack' plugin is configured in rspack.config.mjs
Example:
import { HotUpdaterPlugin } from "@hot-updater/repack";

{
  plugins: [new Repack.RepackPlugin(), new HotUpdaterPlugin()],
}
`);
  }

  return {
    bundleId,
    stdout,
  };
};

export interface RockPluginConfig extends BuildPluginConfig {
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

export const rock =
  (
    config: RockPluginConfig = {
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
          hermes,
        });

        return {
          buildPath,
          bundleId,
          stdout,
        };
      },
      name: "rock",
    };
  };
