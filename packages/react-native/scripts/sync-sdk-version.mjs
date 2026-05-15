import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transformSync } from "oxc-transform";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = join(packageRoot, "package.json");
const sdkVersionPath = join(packageRoot, "src", "sdkVersion.ts");

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
const version = packageJson.version;

if (typeof version !== "string" || version.length === 0) {
  throw new Error("@hot-updater/react-native package.json is missing version");
}

const source = [
  "export const HOT_UPDATER_SDK_VERSION = HotUpdater.SDK_VERSION;",
  "",
].join("\n");

const code =
  transformSync(sdkVersionPath, source, {
    define: {
      "HotUpdater.SDK_VERSION": JSON.stringify(version),
    },
  })?.code ?? source;

const nextContents = code.endsWith("\n") ? code : `${code}\n`;
const currentContents = await readFile(sdkVersionPath, "utf-8").catch(
  () => "",
);

if (currentContents !== nextContents) {
  await writeFile(sdkVersionPath, nextContents);
}
