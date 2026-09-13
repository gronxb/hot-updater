import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lynx } from "@hot-updater/lynx/build";

const [platform, source, entry, runtimeId] = process.argv.slice(2);
if (
  !["ios", "android"].includes(platform) ||
  !source ||
  !entry ||
  !runtimeId?.trim()
) {
  throw new Error(
    "Usage: pnpm build:prebuilt <ios|android> <absolute-native-output-dir> <relative-entry> <native-runtime-id>",
  );
}
if (!path.isAbsolute(source))
  throw new Error("The native output directory must be absolute.");
const cwd = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = await fs.realpath(source);
const outputRoot = path.join(await fs.realpath(cwd), ".hot-updater/lynx");
const relative = path.relative(sourceRoot, outputRoot);
if (
  !relative ||
  (!relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative))
) {
  throw new Error(
    "The source directory must not contain the Hot Updater output directory.",
  );
}

const result = await lynx({
  build: async ({ outDir }) => {
    await fs.cp(sourceRoot, outDir, { recursive: true });
    return { entry, runtimeId };
  },
})({ cwd }).build({ platform });
console.log(JSON.stringify(result, null, 2));
