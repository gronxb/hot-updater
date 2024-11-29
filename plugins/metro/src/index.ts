import { spawn } from "child_process";
import path from "path";
import { type BuildPluginArgs, log } from "@hot-updater/plugin-core";
import fs from "fs/promises";
import { uuidv7 } from "uuidv7";

interface RunBundleArgs {
  cwd: string;
  platform: string;
  buildPath: string;
}

const runBundle = ({ cwd, platform, buildPath }: RunBundleArgs) => {
  const reactNativePath = require.resolve("react-native");
  const cliPath = path.resolve(reactNativePath, "..", "cli.js");

  const bundleOutput = path.join(cwd, "build", `index.${platform}.bundle`);

  const args = [
    "bundle",
    "--assets-dest",
    buildPath,
    "--bundle-output",
    bundleOutput,
    "--dev",
    String(false),
    "--entry-file",
    "index.js",
    "--platform",
    String(platform),
    "--sourcemap-output",
    [bundleOutput, "map"].join("."),
    "--reset-cache",
  ];

  log.normal("\n");

  const bundleId = uuidv7();

  const bundle = spawn(cliPath, args, {
    cwd,
    env: {
      ...process.env,
      HOT_UPDATER_BUNDLE_ID: bundleId,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  return new Promise<string>((resolve, reject) => {
    bundle.stderr?.on("data", (data: Buffer) => {
      log.error(data.toString().trim());
    });

    bundle.on("close", (exitCode: number) => {
      if (exitCode) {
        reject(
          new Error(
            `"react-native bundle" command exited with code ${exitCode}.`,
          ),
        );
      }

      resolve(bundleId);
    });
  });
};

export const metro =
  () =>
  async ({ cwd, platform }: BuildPluginArgs) => {
    const buildPath = path.join(cwd, "build");

    await fs.rm(buildPath, { recursive: true, force: true });
    await fs.mkdir(buildPath, { recursive: true });

    const bundleId = await runBundle({ cwd, platform, buildPath });

    return {
      buildPath,
      bundleId,
    };
  };
