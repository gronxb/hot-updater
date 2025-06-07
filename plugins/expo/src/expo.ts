import fs from "fs";
import path from "path";
import { compileHermes } from "@hot-updater/bare";
import {
  type BasePluginArgs,
  type BuildPlugin,
  type BuildPluginConfig,
  log,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import { resolveMain } from "./resolveMain";

interface RunBundleArgs {
  cwd: string;
  platform: string;
  buildPath: string;
  sourcemap: boolean;
}

const isHermesEnabled = (cwd: string, platform: string): boolean => {
  try {
    const appJsonPath = path.join(cwd, "app.json");
    const { expo } = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));

    const platformJsEngine = expo?.[platform]?.jsEngine;
    const commonJsEngine = expo?.jsEngine;

    if (platformJsEngine !== undefined) {
      return platformJsEngine === "hermes";
    }

    if (commonJsEngine !== undefined) {
      return commonJsEngine === "hermes";
    }
  } catch {}

  return true;
};

const runBundle = async ({
  cwd,
  platform,
  buildPath,
  sourcemap,
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
    "--reset-cache",
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

  const bundleId = await fs.promises
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
  const enableHermes = isHermesEnabled(cwd, platform);
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
    stdout,
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
      build: async ({ platform }) => {
        const buildPath = path.join(cwd, outDir);

        await fs.promises.rm(buildPath, { recursive: true, force: true });
        await fs.promises.mkdir(buildPath, { recursive: true });

        const { bundleId, stdout } = await runBundle({
          cwd,
          platform,
          buildPath,
          sourcemap,
        });

        return {
          buildPath,
          bundleId,
          stdout,
        };
      },
      name: "expo",
    };
  };
