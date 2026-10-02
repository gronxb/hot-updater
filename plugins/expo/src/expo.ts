import fs from "fs";
import path from "path";

import { compileHermes } from "@hot-updater/bare";
import { log } from "@hot-updater/cli-tools";
import type {
  BasePluginArgs,
  BuildPlugin,
  BuildPluginConfig,
  Platform,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import { uuidv7 } from "uuidv7";

import { getConfig } from "./expoConfig";
import { resolveMain } from "./resolveMain";
import { runExpoPrebuild } from "./util/prebuild";

interface RunBundleArgs {
  cwd: string;
  platform: Platform;
  buildPath: string;
  sourcemap: boolean;
  resetCache: boolean;
}

const isHermesEnabled = async (
  cwd: string,
  platform: Platform,
): Promise<boolean> => {
  const { exp } = await getConfig(cwd, {
    skipSDKVersionRequirement: true,
  });
  return (exp[platform]?.jsEngine ?? exp.jsEngine ?? "hermes") === "hermes";
};

const runBundle = async ({
  cwd,
  platform,
  buildPath,
  sourcemap,
  resetCache,
}: RunBundleArgs) => {
  const filename = `index.${platform}`;
  const bundleOutput = path.join(buildPath, `${filename}.bundle`);
  const entryFile = resolveMain(cwd);
  const bundleId = uuidv7();
  const enableHermes = await isHermesEnabled(cwd, platform);

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
    // disable minify when enableHermes is true
    "--minify",
    String(!enableHermes),
    "--assets-dest",
    buildPath,
    ...(sourcemap ? ["--sourcemap-output", `${bundleOutput}.map`] : []),
    ...(resetCache ? ["--reset-cache"] : []),
  ];

  log.normal("\n");

  let stdout: string | null = null;
  try {
    const result = await execa("npx", args, {
      cwd,
      reject: true,
    });
    stdout = result.stdout;
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
    stdout,
  };
};

export interface ExpoPluginConfig extends BuildPluginConfig {
  /**
   * @default false
   * Whether to generate sourcemap for the bundle.
   */
  sourcemap?: boolean;
  /**
   * @default true
   * Whether to reset the Metro cache before bundling.
   */
  resetCache?: boolean;
}

export const expo =
  (config: ExpoPluginConfig = { outDir: "dist", sourcemap: false }) =>
  ({ cwd }: BasePluginArgs): BuildPlugin => {
    const { outDir = "dist", sourcemap = false, resetCache = true } = config;
    return {
      nativeBuild: {
        prebuild: async ({ platform }) => {
          await runExpoPrebuild({ platform });
        },
      },
      build: async ({ platform }) => {
        const buildPath = path.join(cwd, outDir);

        await fs.promises.rm(buildPath, { recursive: true, force: true });
        await fs.promises.mkdir(buildPath, { recursive: true });

        const { bundleId, stdout } = await runBundle({
          cwd,
          platform,
          buildPath,
          sourcemap,
          resetCache,
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
