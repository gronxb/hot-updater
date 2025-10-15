import type { CompressionStrategy } from "@hot-updater/core";

export * from "./createZip";
export * from "./createTarBrotli";
export * from "./createTarGzip";

import { createZip, createZipTargetFiles } from "./createZip";
import { createTarBrotli, createTarBrotliTargetFiles } from "./createTarBrotli";
import { createTarGzip, createTarGzipTargetFiles } from "./createTarGzip";

/**
 * Options for creating a compressed bundle from a directory.
 */
export interface CreateCompressedBundleOptions {
  targetDir: string;
  outfile: string;
  excludeExts?: string[];
}

/**
 * Options for creating a compressed bundle from specific files.
 */
export interface CreateCompressedBundleTargetFilesOptions {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}

/**
 * Creates a compressed bundle using the specified compression strategy.
 *
 * @param strategy - The compression strategy to use ("zip", "tarBrotli", or "tarGzip")
 * @param options - Options for creating the bundle
 * @returns The path to the created bundle file
 *
 * @example
 * ```typescript
 * // Create a zip bundle
 * await createCompressedBundle("zip", {
 *   targetDir: "./dist",
 *   outfile: "./bundle.zip",
 *   excludeExts: [".map"]
 * });
 *
 * // Create a tar+brotli bundle
 * await createCompressedBundle("tarBrotli", {
 *   targetDir: "./dist",
 *   outfile: "./bundle.tar.br"
 * });
 *
 * // Create a tar+gzip bundle
 * await createCompressedBundle("tarGzip", {
 *   targetDir: "./dist",
 *   outfile: "./bundle.tar.gz"
 * });
 * ```
 */
export const createCompressedBundle = async (
  strategy: CompressionStrategy,
  options: CreateCompressedBundleOptions,
): Promise<string> => {
  switch (strategy) {
    case "zip":
      return createZip(options);
    case "tarBrotli":
      return createTarBrotli(options);
    case "tarGzip":
      return createTarGzip(options);
    default:
      throw new Error(`Unsupported compression strategy: ${strategy}`);
  }
};

/**
 * Creates a compressed bundle from specific target files using the specified compression strategy.
 *
 * @param strategy - The compression strategy to use ("zip", "tarBrotli", or "tarGzip")
 * @param options - Options for creating the bundle with specific files
 * @returns The path to the created bundle file
 *
 * @example
 * ```typescript
 * // Create a zip bundle from specific files
 * await createCompressedBundleTargetFiles("zip", {
 *   targetFiles: [
 *     { path: "./assets", name: "assets" },
 *     { path: "./index.bundle.js", name: "index.bundle.js" }
 *   ],
 *   outfile: "./bundle.zip"
 * });
 * ```
 */
export const createCompressedBundleTargetFiles = async (
  strategy: CompressionStrategy,
  options: CreateCompressedBundleTargetFilesOptions,
): Promise<string> => {
  switch (strategy) {
    case "zip":
      return createZipTargetFiles(options);
    case "tarBrotli":
      return createTarBrotliTargetFiles(options);
    case "tarGzip":
      return createTarGzipTargetFiles(options);
    default:
      throw new Error(`Unsupported compression strategy: ${strategy}`);
  }
};

/**
 * Gets the recommended file extension for a compression strategy.
 *
 * @param strategy - The compression strategy
 * @returns The file extension (including the dot)
 */
export const getCompressionExtension = (
  strategy: CompressionStrategy,
): string => {
  switch (strategy) {
    case "zip":
      return ".zip";
    case "tarBrotli":
      return ".tar.br";
    case "tarGzip":
      return ".tar.gz";
    default:
      throw new Error(`Unsupported compression strategy: ${strategy}`);
  }
};

/**
 * Gets the MIME type for a compression strategy.
 *
 * @param strategy - The compression strategy
 * @returns The MIME type string
 */
export const getCompressionMimeType = (
  strategy: CompressionStrategy,
): string => {
  switch (strategy) {
    case "zip":
      return "application/zip";
    case "tarBrotli":
      return "application/x-tar+br";
    case "tarGzip":
      return "application/gzip";
    default:
      throw new Error(`Unsupported compression strategy: ${strategy}`);
  }
};
