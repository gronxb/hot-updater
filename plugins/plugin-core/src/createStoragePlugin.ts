import type {
  StoragePlugin,
  StoragePluginHooks,
  StorageResolveContext,
} from "./types";

/**
 * Storage plugin methods without name and supportedProtocol
 */
type StoragePluginMethods<TContext = unknown> = Omit<
  StoragePlugin<TContext>,
  "name" | "supportedProtocol"
>;

/**
 * Factory function that creates storage plugin methods
 */
type StoragePluginFactory<TConfig, TContext = unknown> = (
  config: TConfig,
) => StoragePluginMethods<TContext>;

/**
 * Configuration options for creating a storage plugin
 */
export interface CreateStoragePluginOptions<TConfig, TContext = unknown> {
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
  factory: StoragePluginFactory<TConfig, TContext>;
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
 *       async getDownloadUrl(storageUri, context) { ... }
 *     };
 *   }
 * });
 * ```
 */
export const createStoragePlugin = <TConfig, TContext = unknown>(
  options: CreateStoragePluginOptions<TConfig, TContext>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): StoragePlugin<TContext> => {
      // Lazy initialization: factory is only called on first method invocation
      let cachedMethods: StoragePluginMethods<TContext> | null = null;
      const getMethods = () => {
        if (!cachedMethods) {
          cachedMethods = options.factory(config);
        }
        return cachedMethods;
      };

      return {
        name: options.name,
        supportedProtocol: options.supportedProtocol,

        async upload(key, filePath) {
          const result = await getMethods().upload(key, filePath);
          await hooks?.onStorageUploaded?.();
          return result;
        },

        async delete(storageUri) {
          return getMethods().delete(storageUri);
        },

        async getDownloadUrl(
          storageUri: string,
          context?: StorageResolveContext<TContext>,
        ) {
          return getMethods().getDownloadUrl(storageUri, context);
        },
      };
    };
  };
};
