import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { finishSpike } from "./spike-assets.mjs";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

// Shared by the ordinary example build and the Hot Updater build callback.
// Native runtime identity belongs to the caller's verified host configuration.
export async function buildPublic({
  framework,
  outDir,
  variant = "A",
  baseURL,
  octaneSource,
}) {
  if (!["react", "vue", "octane"].includes(framework))
    throw new Error("Choose react, vue, or octane.");
  if (!["A", "B", "C"].includes(variant))
    throw new Error("Choose fixture variant A, B, or C.");
  if (!baseURL || !/^https?:\/\//i.test(baseURL))
    throw new Error(
      "Set HOT_UPDATER_SDK_BASE_URL to an explicit HTTP(S) endpoint.",
    );
  if (!path.isAbsolute(outDir) || path.resolve(outDir) === path.resolve(cwd))
    throw new Error(
      "The build output must be an absolute directory below a build root.",
    );
  const env = {
    ...process.env,
    HOT_UPDATER_BUILD_DIR: outDir,
    HOT_UPDATER_SDK_BASE_URL: baseURL,
    HOT_UPDATER_SPIKE_VARIANT: variant,
    HOT_UPDATER_SPIKE_BEHAVIOR: "normal",
    HOT_UPDATER_SPIKE_SDK: "1",
    HOT_UPDATER_SPIKE_RESOURCES: "sdk3",
    HOT_UPDATER_SPIKE_ASSET_PREFIX: "hot-updater:///",
  };
  if (framework === "octane") {
    if (!octaneSource || !path.isAbsolute(octaneSource))
      throw new Error("Octane requires an absolute pinned source checkout.");
    const { stdout, stderr } = await run(
      process.execPath,
      [
        path.join(cwd, "scripts/build-octane.mjs"),
        octaneSource,
        variant,
        "normal",
        "sdk3",
      ],
      {
        cwd,
        env: { ...env, HOT_UPDATER_EXAMPLE_OUT_DIR: outDir },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return {
      ...JSON.parse(await fs.readFile(`${outDir}.build.json`, "utf8")),
      stdout,
      stderr,
    };
  }
  const { stdout, stderr } = await run(
    "pnpm",
    [
      "exec",
      "rspeedy",
      "build",
      "--config",
      `${framework}/lynx.config.ts`,
      "--environment",
      "lynx",
    ],
    { cwd, env, maxBuffer: 10 * 1024 * 1024 },
  );
  const receipt = await finishSpike(outDir, framework, variant, {
    rspeedy: "0.13.5",
    framework:
      framework === "react" ? "@lynx-js/react@0.116.5" : "vue-lynx@0.5.1",
    behavior: "normal",
    resourceSet: "sdk3",
    baseURL,
    assetPrefix: "hot-updater:///",
  });
  return { ...receipt, stdout, stderr };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [framework, variant = "A", octaneSource] = process.argv.slice(2);
  const outDir = path.join(cwd, "dist", framework ?? "unknown");
  const result = await buildPublic({
    framework,
    variant,
    outDir,
    baseURL: process.env.HOT_UPDATER_SDK_BASE_URL,
    octaneSource,
  });
  console.log(
    JSON.stringify(
      { outDir, entry: result.entry, files: result.files },
      null,
      2,
    ),
  );
}
