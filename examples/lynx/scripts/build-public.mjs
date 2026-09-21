import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { preparePinnedOctane } from "./prepare-octane.mjs";
import {
  finishSpike,
  validateStandardStreamingPageBundles,
} from "./spike-assets.mjs";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const buildRoots = [path.join(cwd, ".hot-updater"), path.join(cwd, "dist")];

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const isInsideOrEqual = (parent, child) =>
  parent === child || isInside(parent, child);

const exists = (target) =>
  fs.access(target).then(
    () => true,
    () => false,
  );

async function publishBuild(stageDir, outDir) {
  const stageReceipt = `${stageDir}.build.json`;
  const outReceipt = `${outDir}.build.json`;
  await fs.access(stageReceipt);
  const backupDir = `${stageDir}.previous`;
  const backupReceipt = `${backupDir}.build.json`;
  let movedOutput = false;
  let movedReceipt = false;
  let publishedOutput = false;
  let publishedReceipt = false;
  try {
    if (await exists(outDir)) {
      await fs.rename(outDir, backupDir);
      movedOutput = true;
    }
    if (await exists(outReceipt)) {
      await fs.rename(outReceipt, backupReceipt);
      movedReceipt = true;
    }
    await fs.rename(stageDir, outDir);
    publishedOutput = true;
    await fs.rename(stageReceipt, outReceipt);
    publishedReceipt = true;
  } catch (error) {
    if (publishedOutput) await fs.rm(outDir, { recursive: true, force: true });
    if (publishedReceipt) await fs.rm(outReceipt, { force: true });
    if (movedOutput) await fs.rename(backupDir, outDir);
    if (movedReceipt) await fs.rename(backupReceipt, outReceipt);
    throw error;
  }
  await fs.rm(backupDir, { recursive: true, force: true });
  await fs.rm(backupReceipt, { force: true });
}

// Shared by the ordinary example build and the Hot Updater build callback.
// Native runtime identity belongs to the caller's verified host configuration.
export async function buildPublic({
  framework,
  outDir,
  variant = "A",
  behavior = "normal",
  octaneSource,
  matrixStableFont = false,
}) {
  if (!["react", "vue", "octane"].includes(framework))
    throw new Error("Choose react, vue, or octane.");
  if (!["A", "B", "C"].includes(variant))
    throw new Error("Choose fixture variant A, B, or C.");
  if (!["normal", "unconfirmed", "detail-unconfirmed"].includes(behavior))
    throw new Error(
      "Choose normal, unconfirmed, or detail-unconfirmed behavior.",
    );
  const resolvedOutDir = path.resolve(outDir);
  const buildRoot = buildRoots.find((root) => isInside(root, resolvedOutDir));
  if (!path.isAbsolute(outDir) || !buildRoot)
    throw new Error(
      "The build output must be inside this example's dist or .hot-updater build root.",
    );
  await fs.mkdir(buildRoot, { recursive: true });
  if ((await fs.realpath(buildRoot)) !== buildRoot) {
    throw new Error("The build root must not be a symbolic link.");
  }
  await fs.mkdir(path.dirname(resolvedOutDir), { recursive: true });
  if (
    !isInsideOrEqual(buildRoot, await fs.realpath(path.dirname(resolvedOutDir)))
  ) {
    throw new Error("The build output parent escapes its build root.");
  }
  const stageDir = await fs.mkdtemp(
    path.join(path.dirname(resolvedOutDir), `.${path.basename(outDir)}.build-`),
  );
  const env = {
    ...process.env,
    HOT_UPDATER_BUILD_DIR: stageDir,
    HOT_UPDATER_SPIKE_VARIANT: variant,
    HOT_UPDATER_SPIKE_BEHAVIOR: behavior,
    HOT_UPDATER_SPIKE_SDK: "1",
    HOT_UPDATER_SPIKE_RESOURCES: "sdk3",
    HOT_UPDATER_SPIKE_STABLE_FONT: matrixStableFont ? "1" : "0",
    HOT_UPDATER_SPIKE_ASSET_PREFIX: "hot-updater:///",
  };
  try {
    let result;
    if (framework === "octane") {
      if (octaneSource && !path.isAbsolute(octaneSource))
        throw new Error("Octane requires an absolute pinned source checkout.");
      const resolvedOctaneSource = octaneSource
        ? octaneSource
        : await preparePinnedOctane();
      const { stdout, stderr } = await run(
        process.execPath,
        [
          path.join(cwd, "scripts/build-octane.mjs"),
          resolvedOctaneSource,
          variant,
          behavior,
          "sdk3",
        ],
        {
          cwd,
          env: { ...env, HOT_UPDATER_EXAMPLE_OUT_DIR: stageDir },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      result = {
        ...JSON.parse(await fs.readFile(`${stageDir}.build.json`, "utf8")),
        stdout,
        stderr,
      };
    } else {
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
      await validateStandardStreamingPageBundles(stageDir);
      const receipt = await finishSpike(stageDir, framework, variant, {
        rspeedy: "0.13.5",
        framework:
          framework === "react" ? "@lynx-js/react@0.116.5" : "vue-lynx@0.5.1",
        behavior,
        resourceSet: "sdk3",
        assetPrefix: "hot-updater:///",
      });
      result = { ...receipt, stdout, stderr };
    }
    await publishBuild(stageDir, resolvedOutDir);
    return result;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
    await fs.rm(`${stageDir}.build.json`, { force: true });
    await fs.rm(`${stageDir}.page-graph.json`, { force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [framework, variant = "A", octaneSource, behavior = "normal"] =
    process.argv.slice(2);
  const outDir = path.join(cwd, "dist", framework ?? "unknown");
  const result = await buildPublic({
    framework,
    variant,
    behavior,
    outDir,
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
