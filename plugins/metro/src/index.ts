import { spawn } from "child_process";
import { lstatSync } from "fs";
import path from "path";
import { type BuildPluginArgs, log } from "@hot-updater/plugin-core";
import fs from "fs/promises";
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
  ];

  log.normal("\n");
  const bundle = spawn(cliPath, args, { cwd });

  return new Promise<void>((resolve, reject) => {
    bundle.stdout?.on("data", (data: Buffer) => {
      log.normal(data.toString().trim());
    });

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

      resolve();
    });
  });
};

export const metro =
  () =>
  async ({ cwd, platform }: BuildPluginArgs) => {
    const buildPath = path.join(cwd, "build");

    await fs.rm(buildPath, { recursive: true, force: true });
    await fs.mkdir(buildPath, { recursive: true });

    await runBundle({ cwd, platform, buildPath });

    const files = await fs.readdir(buildPath, { recursive: true });
    const outputs = files
      .filter((file) => !lstatSync(path.join(buildPath, file)).isDirectory())
      .map((output) => path.join(buildPath, output));

    return {
      buildPath,
      outputs,
    };
  };
