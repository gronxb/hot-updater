import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { finishSpike } from "./spike-assets.mjs";

const [source, variant, behavior = "normal", resourceSet = "basic"] =
  process.argv.slice(2);
if (
  !source ||
  !path.isAbsolute(source) ||
  !["A", "B", "C"].includes(variant) ||
  !["normal", "unconfirmed", "fatal", "double-ready"].includes(behavior) ||
  ![
    "basic",
    "fonts",
    "dynamic",
    "sdk1",
    "sdk2",
    "sdk3",
    "http",
    "external",
    "external2",
    "resources",
    "resources2",
    "resources3",
  ].includes(resourceSet)
) {
  throw new Error(
    "Usage: node scripts/build-octane.mjs <absolute-pinned-octane-checkout> <A|B|C> [normal|unconfirmed|fatal|double-ready] [basic|fonts|dynamic|sdk1|sdk2|sdk3|http|external|external2|resources|resources2|resources3]",
  );
}
const run = promisify(execFile);
const pin = "c31f629185f7d768c821557f6fb49dc46daf671c";
const { stdout: head } = await run("git", ["rev-parse", "HEAD"], {
  cwd: source,
});
if (head.trim() !== pin)
  throw new Error(`Octane checkout must be exactly ${pin}`);
const { stdout: changed } = await run(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: source },
);
if (changed.trim())
  throw new Error("Pinned Octane source has tracked modifications");
const isSdk = resourceSet.startsWith("sdk");
if (isSdk && !process.env.HOT_UPDATER_SDK_BASE_URL)
  throw new Error("SDK fixtures require explicit HOT_UPDATER_SDK_BASE_URL");
const cwd = fileURLToPath(new URL("..", import.meta.url));
const plugin = path.join(source, "packages/rspeedy-plugin-octane");
const fixture = await fs.mkdtemp(path.join(plugin, "examples/hot-updater-g1-"));
const name = `${variant}${behavior === "normal" ? "" : `-${behavior}`}${resourceSet === "basic" ? "" : `-${resourceSet}`}-managed`;
const exampleOutDir = process.env.HOT_UPDATER_EXAMPLE_OUT_DIR;
if (exampleOutDir && (!isSdk || !path.isAbsolute(exampleOutDir)))
  throw new Error(
    "Explicit example output requires a public SDK mode and absolute directory.",
  );
const outDir = exampleOutDir ?? path.join(cwd, ".hot-updater/g1/octane", name);
try {
  await fs.cp(path.join(cwd, "octane"), fixture, { recursive: true });
  if (isSdk) {
    await fs.copyFile(
      path.join(cwd, "spike/sdk.ts"),
      path.join(fixture, "src/sdk-shared.ts"),
    );
    await fs.mkdir(path.join(fixture, "node_modules/@hot-updater"), {
      recursive: true,
    });
    await fs.symlink(
      path.join(cwd, "node_modules/@hot-updater/lynx"),
      path.join(fixture, "node_modules/@hot-updater/lynx"),
    );
  } else {
    await fs.rm(path.join(fixture, "src/Sdk.lynx.tsrx"));
    await fs.rm(path.join(fixture, "src/sdk.ts"));
  }
  await fs.copyFile(
    path.join(cwd, "spike/bridge.ts"),
    path.join(fixture, "src/bridge.ts"),
  );
  await fs.copyFile(
    path.join(cwd, "spike/lazy.ts"),
    path.join(fixture, "src/lazy.ts"),
  );
  await fs.copyFile(
    path.join(cwd, "style.css"),
    path.join(fixture, "src/style.css"),
  );
  await fs.cp(
    path.join(cwd, "spike/native-package"),
    path.join(fixture, "node_modules/@hot-updater/lynx-g1-probe"),
    { recursive: true },
  );
  await run(
    "pnpm",
    ["exec", "tsrx-tsc", "--noEmit", "-p", path.join(fixture, "tsconfig.json")],
    {
      cwd: plugin,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const { stdout, stderr } = await run(
    "pnpm",
    ["exec", "rspeedy", "build", "--root", fixture, "--environment", "lynx"],
    {
      cwd: plugin,
      env: {
        ...process.env,
        HOT_UPDATER_BUILD_DIR: outDir,
        HOT_UPDATER_SPIKE_VARIANT: variant,
        HOT_UPDATER_SPIKE_SDK: isSdk ? "1" : "0",
        HOT_UPDATER_SPIKE_BEHAVIOR: behavior,
        HOT_UPDATER_SPIKE_RESOURCES: resourceSet.startsWith("external")
          ? "external"
          : resourceSet.startsWith("resources")
            ? "resources"
            : resourceSet,
        HOT_UPDATER_SPIKE_ASSET_PREFIX: "hot-updater:///",
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  console.log(
    JSON.stringify(
      await finishSpike(outDir, "octane", variant, {
        repository: "https://github.com/octanejs/octane",
        commit: pin,
        rspeedy: "0.16.0",
        behavior,
        resourceSet,
        ...(isSdk ? { baseURL: process.env.HOT_UPDATER_SDK_BASE_URL } : {}),
        assetPrefix: "hot-updater:///",
      }),
      null,
      2,
    ),
  );
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
