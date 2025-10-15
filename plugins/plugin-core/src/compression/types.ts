/**
 * Interface for compression service implementations.
 * Each compression strategy must implement this interface.
 */
export interface CompressionService {
  /**
   * Compresses a directory into an archive file.
   *
   * @param inputDir - The directory containing files to compress
   * @param outputFile - The path where the compressed archive will be written
   * @returns Promise that resolves when compression is complete
   */
  compress(inputDir: string, outputFile: string): Promise<void>;

  /**
   * Gets the file extension for this compression format.
   *
   * @returns File extension including the dot (e.g., ".zip", ".tar.br", ".tar.gz")
   */
  getFileExtension(): string;

  /**
   * Gets the Content-Encoding header value for HTTP responses.
   * Returns null for formats that don't require Content-Encoding (like zip).
   *
   * @returns Content-Encoding value (e.g., "br", "gzip") or null
   */
  getContentEncoding(): string | null;

  /**
   * Gets the MIME type for this compression format.
   *
   * @returns MIME type string (e.g., "application/zip", "application/x-tar")
   */
  getMimeType(): string;
}

/**
 * Options for compression operations.
 */
export interface CompressionOptions {
  /**
   * File extensions or patterns to exclude from compression.
   * @example [".map", ".DS_Store"]
   */
  excludeExts?: string[];
}
