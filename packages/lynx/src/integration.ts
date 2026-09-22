import fs from "node:fs";
import path from "node:path";

import type { InitIntegrationDescriptor } from "@hot-updater/cli-tools";

const BUILD_MODULE = "hot-updater.lynx";
const BUILD_MODULE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

export const initIntegration = {
  schemaVersion: 1,
  id: "lynx",
  label: "Lynx",
  hint: "Framework-independent Lynx build callback",
  dependencies: ["@hot-updater/lynx"],
  devDependencies: ["dotenv"],
  build: {
    imports: [
      { pkg: "@hot-updater/lynx/build", named: ["lynx"] },
      { pkg: `./${BUILD_MODULE}`, named: ["createLynxBuild"] },
    ],
    configString: "lynx({ build: createLynxBuild })",
  },
  prepare: ({ cwd }) => {
    const buildModule = BUILD_MODULE_EXTENSIONS.find((extension) =>
      fs.existsSync(path.join(cwd, `${BUILD_MODULE}${extension}`)),
    );
    if (!buildModule) {
      throw new Error(
        `Lynx init requires ${BUILD_MODULE}.ts (or .mts/.js/.mjs) exporting createLynxBuild. The callback owns the selected compiler and must return entry, pageEntries, pageEssentialResources, and runtimeId.`,
      );
    }
  },
} satisfies InitIntegrationDescriptor;
