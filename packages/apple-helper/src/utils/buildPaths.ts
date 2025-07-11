import path from "node:path";
import os from "node:os";

/**
 * Build paths configuration for Apple platform builds
 */
export interface BuildPaths {
  /** Main build directory */
  buildDir: string;
  /** Directory for exported IPAs and apps */
  exportDir: string;
  /** Directory for Xcode archives */
  archiveDir: string;
  /** Directory for package artifacts */
  packageDir: string;
  /** Directory for Xcode derived data */
  derivedDataDir: string;
}

/**
 * Gets the cache root path for the current platform
 * @returns Cache root directory path
 */
const getCacheRootPath = (): string => {
  return path.join(os.homedir(), ".hot-updater", "cache");
};

/**
 * Creates build paths for a specific platform
 * @param platformName - The platform name (ios, macos, tvos, visionos)
 * @returns Object containing all build-related directory paths
 * 
 * @example
 * ```typescript
 * const paths = createBuildPaths("ios");
 * console.log(paths.exportDir); // ~/.hot-updater/cache/ios/export
 * ```
 */
export const createBuildPaths = (platformName: string): BuildPaths => {
  const buildDir = path.join(getCacheRootPath(), platformName);

  return {
    buildDir,
    exportDir: path.join(buildDir, "export"),
    archiveDir: path.join(buildDir, "archive"),
    packageDir: path.join(buildDir, "package"),
    derivedDataDir: path.join(buildDir, "derivedData"),
  };
};