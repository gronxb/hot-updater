import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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
  const searchFrom = options?.searchFrom ?? getCwd();
  const packageJsonPath = resolvePackageJsonPath(packageName, searchFrom);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
    version?: string;
  };

  if (!packageJson.version) {
    throw new Error(`Failed to resolve version for package: ${packageName}`);
  }

  return packageJson.version;
};

const resolvePackageJsonPath = (packageName: string, searchFrom: string) => {
  try {
    return require.resolve(`${packageName}/package.json`, {
      paths: [searchFrom],
    });
  } catch (error) {
    if (!isPackageJsonExportError(error)) {
      throw error;
    }

    const packageEntryPath = require.resolve(packageName, {
      paths: [searchFrom],
    });
    const fallbackPackageJsonPath = findPackageJsonUpwards(
      packageEntryPath,
      packageName,
    );

    if (!fallbackPackageJsonPath) {
      throw error;
    }

    return fallbackPackageJsonPath;
  }
};

const isPackageJsonExportError = (error: unknown) => {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
      error.code === "MODULE_NOT_FOUND")
  );
};

const findPackageJsonUpwards = (entryPath: string, packageName: string) => {
  let currentDir = path.dirname(entryPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf-8"),
      ) as {
        name?: string;
        version?: string;
      };

      if (packageJson.name === packageName && packageJson.version) {
        return packageJsonPath;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
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
