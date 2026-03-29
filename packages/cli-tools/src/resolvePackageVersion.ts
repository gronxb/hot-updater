import fs from "node:fs";
import { createRequire } from "node:module";
import { getCwd } from "./cwd";

const require = createRequire(import.meta.url);

export const HOT_UPDATER_SERVER_PACKAGE_VERSION_ENV =
  "HOT_UPDATER_SERVER_PACKAGE_VERSION";

export const resolvePackageVersion = (
  packageName: string,
  options?: {
    searchFrom?: string;
  },
) => {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: [options?.searchFrom ?? getCwd()],
  });
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
    version?: string;
  };

  if (!packageJson.version) {
    throw new Error(`Failed to resolve version for package: ${packageName}`);
  }

  return packageJson.version;
};

export const resolveHotUpdaterServerVersion = (
  currentPackageName: string,
  options?: {
    searchFrom?: string;
  },
) => {
  const override = process.env[HOT_UPDATER_SERVER_PACKAGE_VERSION_ENV]?.trim();

  return override || resolvePackageVersion(currentPackageName, options);
};
