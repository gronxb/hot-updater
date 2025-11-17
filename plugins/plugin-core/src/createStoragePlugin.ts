import type { StoragePlugin, StoragePluginHooks } from "./types";

/**
 * Storage plugin methods without name and supportedProtocol
 */
type StoragePluginMethods = Omit<StoragePlugin, "name" | "supportedProtocol">;

/**
 * Factory function that creates storage plugin methods
 */
type StoragePluginFactory<TConfig> = (config: TConfig) => StoragePluginMethods;

/**
 * Configuration options for creating a storage plugin
 */
export interface CreateStoragePluginOptions<TConfig> {
  /**
   * The name of the storage plugin (e.g., "s3Storage", "r2Storage")
   */
  name: string;
  /**
   * The protocol that this storage plugin supports (e.g., "s3", "r2", "gs").
   *
   * This value is stored in the database and is used by the server to understand
   * how to fetch assets.
   * For example, if the protocol is "s3", assets will be stored in the format:
   *   s3://bucketName/key
   */
  supportedProtocol: string;
  /**
   * Function that creates the storage plugin methods (upload, delete, getDownloadUrl)
   */
  factory: StoragePluginFactory<TConfig>;
}

/**
 * Creates a storage plugin with lazy initialization and automatic hook execution.
 *
 * This factory function abstracts the double currying pattern used by all storage plugins,
 * ensuring consistent lazy initialization behavior across different storage providers.
 * Hooks are automatically executed at appropriate times without requiring manual invocation.
 *
 * @param options - Configuration options for the storage plugin
 * @returns A double-curried function that lazily initializes the storage plugin
 *
 * @example
 * ```typescript
 * export const s3Storage = createStoragePlugin<S3StorageConfig>({
 *   name: "s3Storage",
 *   supportedProtocol: "s3",
 *   factory: (config) => {
 *     const client = new S3Client(config);
 *     return {
 *       async upload(key, filePath) { ... },
 *       async delete(storageUri) { ... },
 *       async getDownloadUrl(storageUri) { ... }
 *     };
 *   }
 * });
 * ```
 */
export const createStoragePlugin = <TConfig>(
  options: CreateStoragePluginOptions<TConfig>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): StoragePlugin => {
      const methods = options.factory(config);

      // Wrap upload method to automatically call onStorageUploaded hook
      const originalUpload = methods.upload;
      const wrappedUpload: typeof originalUpload = async (key, filePath) => {
        const result = await originalUpload(key, filePath);
        await hooks?.onStorageUploaded?.();
        return result;
      };

      return {
        name: options.name,
        supportedProtocol: options.supportedProtocol,
        ...methods,
        upload: wrappedUpload,
      };
    };
  };
};
