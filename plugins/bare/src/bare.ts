import { createHash } from "crypto";
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

const BARE_BUILD_CACHE_VERSION = 1;

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveCacheRoot(cwd: string) {
  const cacheDir = process.env.HOT_UPDATER_BARE_BUILD_CACHE_DIR?.trim();
  if (!cacheDir) {
    return null;
  }

  return path.resolve(cwd, cacheDir);
}

function resolveCacheKey({
  enableHermes,
  entryFile,
  platform,
  resetCache,
  sourcemap,
}: Omit<RunBundleArgs, "buildPath" | "cwd">) {
  const inputKey = process.env.HOT_UPDATER_BARE_BUILD_CACHE_KEY?.trim();
  if (!inputKey) {
    return null;
  }

  return hashText(
    JSON.stringify({
      cacheVersion: BARE_BUILD_CACHE_VERSION,
      enableHermes,
      entryFile,
      inputKey,
      platform,
      resetCache,
      sourcemap,
    }),
  );
}

function resolveCachePaths({
  cwd,
  enableHermes,
  entryFile,
  platform,
  resetCache,
  sourcemap,
}: Omit<RunBundleArgs, "buildPath">) {
  const root = resolveCacheRoot(cwd);
  const key = resolveCacheKey({
    enableHermes,
    entryFile,
    platform,
    resetCache,
    sourcemap,
  });
  if (!root || !key) {
    return null;
  }

  const entryDir = path.join(root, key);
  return {
    entryDir,
    filesDir: path.join(entryDir, "files"),
    key,
    manifestPath: path.join(entryDir, "manifest.json"),
    root,
  };
}

async function restoreBundleBuildFromCache({
  buildPath,
  cachePaths,
}: {
  buildPath: string;
  cachePaths: NonNullable<ReturnType<typeof resolveCachePaths>>;
}) {
  if (!(await pathExists(cachePaths.manifestPath))) {
    return null;
  }

  try {
    const metadata = JSON.parse(
      await fs.readFile(cachePaths.manifestPath, "utf8"),
    ) as { stdout?: unknown };
    await fs.cp(cachePaths.filesDir, buildPath, { recursive: true });
    log.normal(`[bare] reused build cache ${cachePaths.key.slice(0, 12)}\n`);
    return {
      stdout: typeof metadata.stdout === "string" ? metadata.stdout : null,
    };
  } catch {
    return null;
  }
}

async function saveBundleBuildToCache({
  buildPath,
  cachePaths,
  stdout,
}: {
  buildPath: string;
  cachePaths: NonNullable<ReturnType<typeof resolveCachePaths>>;
  stdout: string | null;
}) {
  if (await pathExists(cachePaths.manifestPath)) {
    return;
  }

  const tempDir = path.join(
    cachePaths.root,
    `${cachePaths.key}.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(tempDir), { recursive: true });
  await fs.cp(buildPath, path.join(tempDir, "files"), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, "manifest.json"),
    `${JSON.stringify({ cacheVersion: BARE_BUILD_CACHE_VERSION, stdout })}\n`,
  );

  try {
    await fs.rename(tempDir, cachePaths.entryDir);
    log.normal(`[bare] saved build cache ${cachePaths.key.slice(0, 12)}\n`);
  } catch {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
  const cachePaths = resolveCachePaths({
    cwd,
    enableHermes,
    entryFile,
    platform,
    resetCache,
    sourcemap,
  });
  const cached = cachePaths
    ? await restoreBundleBuildFromCache({ buildPath, cachePaths })
    : null;
  if (cached) {
    return {
      bundleId,
      stdout: cached.stdout,
    };
  }

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
    if (cachePaths) {
      await saveBundleBuildToCache({
        buildPath,
        cachePaths,
        stdout: hermesVersion,
      });
    }

    return {
      bundleId,
      stdout: hermesVersion,
    };
  }

  if (cachePaths) {
    await saveBundleBuildToCache({ buildPath, cachePaths, stdout: null });
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
