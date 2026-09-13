import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { finishSpike } from "./spike-assets.mjs";

const [framework, variant, behavior = "normal", resourceSet = "basic"] =
  process.argv.slice(2);
if (
  !["react", "vue"].includes(framework) ||
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
    "Usage: node scripts/build-spike.mjs <react|vue> <A|B|C> [normal|unconfirmed|fatal|double-ready] [basic|fonts|dynamic|sdk1|sdk2|sdk3|http|external|external2|resources|resources2|resources3]",
  );
}
const isSdk = resourceSet.startsWith("sdk");
if (isSdk && !process.env.HOT_UPDATER_SDK_BASE_URL)
  throw new Error("SDK fixtures require explicit HOT_UPDATER_SDK_BASE_URL");
const cwd = fileURLToPath(new URL("..", import.meta.url));
const name = `${variant}${behavior === "normal" ? "" : `-${behavior}`}${resourceSet === "basic" ? "" : `-${resourceSet}`}-managed`;
const outDir = path.join(cwd, ".hot-updater/g1", framework, name);
const { stdout, stderr } = await promisify(execFile)(
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
  {
    cwd,
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
    await finishSpike(outDir, framework, variant, {
      rspeedy: "0.13.5",
      framework:
        framework === "react" ? "@lynx-js/react@0.116.5" : "vue-lynx@0.5.1",
      behavior,
      resourceSet,
      ...(isSdk ? { baseURL: process.env.HOT_UPDATER_SDK_BASE_URL } : {}),
      assetPrefix: "hot-updater:///",
    }),
    null,
    2,
  ),
);
