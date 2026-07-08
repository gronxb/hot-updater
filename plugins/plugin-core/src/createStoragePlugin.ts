import type {
  StoragePlugin,
  StoragePluginCore,
  StoragePluginHooks,
  StorageUploadSource,
} from "./types";

type StoragePluginFactory<TConfig> = (config: TConfig) => StoragePluginCore;

export const getStorageUploadFilePath = (source: StorageUploadSource) => {
  if (source.kind !== "file") {
    throw new Error("This storage plugin only supports file upload sources.");
  }

  return source.filePath;
};

interface CreateStoragePluginOptions<TConfig> {
  name: string;
  supportedProtocol: string;
  factory: StoragePluginFactory<TConfig>;
}

const wrapStorageUpload = (
  implementation: StoragePluginCore,
  hooks?: StoragePluginHooks,
): NonNullable<StoragePluginCore["upload"]> => {
  return async (params) => {
    const result = await implementation.upload?.(params);
    if (!result) {
      throw new Error("Storage plugin does not implement upload.");
    }

    await hooks?.onStorageUploaded?.();
    return result;
  };
};

export const createStoragePlugin = <TConfig>(
  options: CreateStoragePluginOptions<TConfig>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): StoragePlugin => {
      const implementation = options.factory(config);

      return {
        name: options.name,
        supportedProtocol: options.supportedProtocol,
        ...(implementation.delete ? { delete: implementation.delete } : {}),
        ...(implementation.downloadFile
          ? { downloadFile: implementation.downloadFile }
          : {}),
        ...(implementation.exists ? { exists: implementation.exists } : {}),
        ...(implementation.getDownloadUrl
          ? { getDownloadUrl: implementation.getDownloadUrl }
          : {}),
        ...(implementation.readBytes
          ? { readBytes: implementation.readBytes }
          : {}),
        ...(implementation.readText
          ? { readText: implementation.readText }
          : {}),
        ...(implementation.upload
          ? { upload: wrapStorageUpload(implementation, hooks) }
          : {}),
      };
    };
  };
};
