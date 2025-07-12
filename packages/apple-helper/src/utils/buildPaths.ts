import path from "node:path";

/**
 * Build paths configuration for Apple platform builds
 */
export interface OutputPaths {
  /** Main build directory */
  outputDir: string;
  /** Directory for exported IPAs and apps */
  exportDir: string;
  /** Directory for Xcode archives */
  archiveDir: string;
  /** Directory for package artifacts */
  packageDir: string;
  /** Directory for Xcode derived data */
  derivedDataDir: string;
}

// const getCacheRootPath = (): string => {
//   return path.join(getCwd(), ".hot-updater", "cache");
// };

export const createOutputPaths = (outputPath: string): OutputPaths => {
  const outputDir = path.join(outputPath);

  return {
    outputDir,
    exportDir: path.join(outputDir, "export"),
    archiveDir: path.join(outputDir, "archive"),
    packageDir: path.join(outputDir, "package"),
    derivedDataDir: path.join(outputDir, "derivedData"),
  };
};
