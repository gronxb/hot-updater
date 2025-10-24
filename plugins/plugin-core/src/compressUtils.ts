import type { CompressStrategy } from "@hot-updater/core";

/**
 * Get file extension for the given compression strategy
 *
 * @param strategy - The compression strategy
 * @returns File extension including the dot (e.g., ".zip", ".tar.br")
 */
export const getCompressExtension = (strategy: CompressStrategy): string => {
  switch (strategy) {
    case "zip":
      return ".zip";
    case "tar.br":
      return ".tar.br";
    default:
      throw new Error(`Unknown compress strategy: ${strategy}`);
  }
};

/**
 * Get Content-Encoding header value for the given compression strategy
 * Returns undefined if no Content-Encoding header is needed (e.g., for zip)
 *
 * @param strategy - The compression strategy
 * @returns Content-Encoding value or undefined
 */
export const getContentEncoding = (
  strategy: CompressStrategy,
): string | undefined => {
  switch (strategy) {
    case "zip":
      return undefined; // zip doesn't use Content-Encoding
    case "tar.br":
      return "br"; // brotli
    default:
      throw new Error(`Unknown compress strategy: ${strategy}`);
  }
};

/**
 * Get Content-Type header value for the given compression strategy
 *
 * @param strategy - The compression strategy
 * @returns MIME type for the compression format
 */
export const getContentType = (strategy: CompressStrategy): string => {
  switch (strategy) {
    case "zip":
      return "application/zip";
    case "tar.br":
      return "application/x-tar";
    default:
      throw new Error(`Unknown compress strategy: ${strategy}`);
  }
};

/**
 * Detect compression strategy from file extension
 *
 * @param filename - The filename to check
 * @returns Detected compression strategy or undefined if unknown
 */
export const detectCompressStrategy = (
  filename: string,
): CompressStrategy | undefined => {
  if (filename.endsWith(".tar.br")) {
    return "tar.br";
  }
  if (filename.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
};
