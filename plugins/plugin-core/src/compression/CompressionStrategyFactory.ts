import type { CompressionStrategy } from "@hot-updater/core";
import { TarBrotliCompressionService } from "./TarBrotliCompressionService";
import { TarGzipCompressionService } from "./TarGzipCompressionService";
import type { CompressionOptions, CompressionService } from "./types";
import { ZipCompressionService } from "./ZipCompressionService";

/**
 * Creates a compression service instance for the specified strategy.
 *
 * @param strategy - The compression strategy to use
 * @param options - Optional compression options
 * @returns A compression service instance
 * @throws Error if the strategy is not recognized
 */
export function createCompressionService(
  strategy: CompressionStrategy,
  options?: CompressionOptions,
): CompressionService {
  switch (strategy) {
    case "zip":
      return new ZipCompressionService(options);
    case "tarBrotli":
      return new TarBrotliCompressionService(options);
    case "tarGzip":
      return new TarGzipCompressionService(options);
    default:
      throw new Error(
        `Unknown compression strategy: ${strategy}. ` +
          `Supported strategies: zip, tarBrotli, tarGzip`,
      );
  }
}

/**
 * Gets all available compression strategies.
 *
 * @returns Array of supported compression strategy names
 */
export function getAvailableCompressionStrategies(): CompressionStrategy[] {
  return ["zip", "tarBrotli", "tarGzip"];
}
