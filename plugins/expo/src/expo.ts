import fs from "fs";
import path from "path";

import { compileHermes } from "@hot-updater/bare";
import { log, readBundleSigningPublicKeyFile } from "@hot-updater/cli-tools";
import type {
  BasePluginArgs,
  BuildPlugin,
  BuildPluginConfig,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import { uuidv7 } from "uuidv7";

import { getConfig } from "./expoConfig";
import { resolveMain } from "./resolveMain";
import { runExpoPrebuild } from "./util/prebuild";

interface RunBundleArgs {
  cwd: string;
  platform: string;
  buildPath: string;
  sourcemap: boolean;
  resetCache: boolean;
}

type HotUpdaterExpoPluginProps = {
  publicKeyPath?: string;
};

const getHotUpdaterExpoPluginProps = (
  plugins: Awaited<ReturnType<typeof getConfig>>["exp"]["plugins"],
): HotUpdaterExpoPluginProps | undefined => {
  const entry = plugins?.find(
    (plugin) =>
      Array.isArray(plugin) &&
      (plugin[0] === "@hot-updater/expo" ||
        plugin[0] === "@hot-updater/expo/app.plugin.js"),
  );
  if (!entry || !Array.isArray(entry)) return undefined;
  const props = entry[1];
  return typeof props === "object" && props !== null
    ? (props as HotUpdaterExpoPluginProps)
    : undefined;
};

export const getExpoFingerprintExtraSources = async (
  cwd: string,
): Promise<string[]> => {
  const { exp } = await getConfig(cwd, {
    skipSDKVersionRequirement: true,
  });
  const publicKeyPath = getHotUpdaterExpoPluginProps(
    exp.plugins,
  )?.publicKeyPath;
  if (publicKeyPath === undefined) return [];
  if (typeof publicKeyPath !== "string" || !publicKeyPath.trim()) {
    throw new Error(
      "@hot-updater/expo publicKeyPath must be a non-empty path.",
    );
  }
  return [publicKeyPath];
};

export const getExpoBundleSigningPublicKey = async (
  cwd: string,
): Promise<{ readonly publicKey: string } | null> => {
  const { exp } = await getConfig(cwd, {
    skipSDKVersionRequirement: true,
  });
  const publicKeyPath = getHotUpdaterExpoPluginProps(
    exp.plugins,
  )?.publicKeyPath;
  if (publicKeyPath === undefined) return null;
  if (typeof publicKeyPath !== "string" || !publicKeyPath.trim()) {
    throw new Error(
      "@hot-updater/expo publicKeyPath must be a non-empty path.",
    );
  }
  return {
    publicKey: await readBundleSigningPublicKeyFile(publicKeyPath, { cwd }),
  };
};

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
  resetCache,
}: RunBundleArgs) => {
  const filename = `index.${platform}`;
  const bundleOutput = path.join(buildPath, `${filename}.bundle`);
  const entryFile = resolveMain(cwd);
  const bundleId = uuidv7();
  const enableHermes = isHermesEnabled(cwd, platform);

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
        getBundleSigningPublicKey: () => getExpoBundleSigningPublicKey(cwd),
        getFingerprintExtraSources: async () =>
          getExpoFingerprintExtraSources(cwd),
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
