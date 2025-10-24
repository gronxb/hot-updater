import type { CompressStrategy } from "@hot-updater/core";
import { createTarBrTargetFiles } from "./createTarBr";
import { createZipTargetFiles } from "./createZip";

/**
 * Creates a compressed bundle using the specified compression strategy
 *
 * @param compressStrategy - The compression strategy to use (default: "zip")
 * @param outfile - The output file path
 * @param targetFiles - Array of files to compress
 * @returns Promise that resolves to the output file path
 */
export const createCompressedBundle = async ({
  compressStrategy = "zip",
  outfile,
  targetFiles,
}: {
  compressStrategy?: CompressStrategy;
  outfile: string;
  targetFiles: { path: string; name: string }[];
}): Promise<string> => {
  switch (compressStrategy) {
    case "zip":
      return createZipTargetFiles({ outfile, targetFiles });
    case "tar.br":
      return createTarBrTargetFiles({ outfile, targetFiles });
    default:
      throw new Error(`Unsupported compress strategy: ${compressStrategy}`);
  }
};
