import { fileURLToPath } from "node:url";

import { lynx } from "@hot-updater/lynx/build";

import { buildPublic } from "./build-public.mjs";

const [framework, platform, runtimeId, variant = "A", octaneSource] =
  process.argv.slice(2);
if (
  !["react", "vue", "octane"].includes(framework) ||
  !["ios", "android"].includes(platform) ||
  !runtimeId?.trim()
) {
  throw new Error(
    "Usage: pnpm build:hot-updater <react|vue|octane> <ios|android> <native-runtime-id> [A|B|C] [octane-source]",
  );
}

const cwd = fileURLToPath(new URL("..", import.meta.url));
const result = await lynx({
  outDir: `.hot-updater/lynx/${framework}`,
  build: async ({ outDir }) => {
    const { entry, stdout } = await buildPublic({
      framework,
      outDir,
      variant,
      baseURL: process.env.HOT_UPDATER_SDK_BASE_URL,
      octaneSource,
    });
    return { entry, runtimeId, stdout };
  },
})({ cwd }).build({ platform });
console.log(JSON.stringify(result, null, 2));
