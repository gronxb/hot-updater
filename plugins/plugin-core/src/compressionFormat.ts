import mime from "mime";

/**
 * Compression format type definition
 */
export type CompressionFormat = "zip" | "tar.br" | "tar.gz";

/**
 * Compression format metadata
 */
export interface CompressionFormatInfo {
  format: CompressionFormat;
  fileExtension: string;
  mimeType?: string;
}

/**
 * Compression formats registry
 * Add new formats here to support additional compression types
 */
const COMPRESSION_FORMATS: Record<CompressionFormat, CompressionFormatInfo> = {
  zip: {
    format: "zip",
    fileExtension: ".zip",
    mimeType: "application/zip",
  },
  "tar.br": {
    format: "tar.br",
    fileExtension: ".tar.br",
    mimeType: "application/x-tar",
  },
  "tar.gz": {
    format: "tar.gz",
    fileExtension: ".tar.gz",
    mimeType: "application/x-tar",
  },
};

/**
 * Finds the compression format matching a filename extension
 * @param filename The filename to match
 * @returns Compression format information, or undefined when nothing matches
 */
function findCompressionFormat(
  filename: string,
): CompressionFormatInfo | undefined {
  return Object.values(COMPRESSION_FORMATS).find((info) =>
    filename.endsWith(info.fileExtension),
  );
}

/**
 * Detects compression format from filename
 * @param filename The filename to detect format from
 * @returns Compression format information
 */
export function detectCompressionFormat(
  filename: string,
): CompressionFormatInfo {
  // Default to zip if no match
  return findCompressionFormat(filename) ?? COMPRESSION_FORMATS.zip;
}

/**
 * Gets MIME type for a filename
 * @param filename The filename to get MIME type for
 * @returns MIME type string, or undefined when the filename is not an archive
 */
export function getCompressionMimeType(filename: string): string | undefined {
  return findCompressionFormat(filename)?.mimeType;
}

/**
 * Gets Content-Type for a bundle file with 3-tier fallback
 * @param bundlePath The bundle file path
 * @returns Content-Type string (never undefined, falls back to application/octet-stream)
 */
export function getContentType(bundlePath: string): string {
  const filename = bundlePath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();

  return (
    mime.getType(bundlePath) ??
    getCompressionMimeType(filename ?? "") ??
    "application/octet-stream"
  );
}
