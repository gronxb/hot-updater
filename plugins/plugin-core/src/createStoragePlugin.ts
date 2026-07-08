import type {
  NodeStoragePlugin,
  NodeStorageProfile,
  RuntimeStoragePlugin,
  RuntimeStorageProfile,
  StoragePlugin,
  StoragePluginCore,
  StoragePluginHooks,
  StorageUploadSource,
  UniversalStoragePlugin,
} from "./types";

type StoragePluginFactory<TConfig, TContext = unknown> = (
  config: TConfig,
) => StoragePluginCore<TContext>;

type StorageProfileFactory<TConfig, TProfiles> = (config: TConfig) => TProfiles;

export const getStorageUploadFilePath = (source: StorageUploadSource) => {
  if (source.kind !== "file") {
    throw new Error("This storage plugin only supports file upload sources.");
  }

  return source.filePath;
};

interface BaseStoragePluginOptions<TConfig, TContext = unknown> {
  name: string;
  supportedProtocol: string;
  factory: StoragePluginFactory<TConfig, TContext>;
}

type CreateStoragePluginOptions<
  TConfig,
  TContext = unknown,
> = BaseStoragePluginOptions<TConfig, TContext>;

type CreateNodeStoragePluginOptions<TConfig> = Omit<
  BaseStoragePluginOptions<TConfig, unknown>,
  "factory"
> & {
  factory: StorageProfileFactory<TConfig, NodeStorageProfile>;
};

type CreateRuntimeStoragePluginOptions<TConfig, TContext = unknown> = Omit<
  BaseStoragePluginOptions<TConfig, TContext>,
  "factory"
> & {
  factory: StorageProfileFactory<TConfig, RuntimeStorageProfile<TContext>>;
};

type CreateUniversalStoragePluginOptions<TConfig, TContext = unknown> = Omit<
  BaseStoragePluginOptions<TConfig, TContext>,
  "factory"
> & {
  factory: StorageProfileFactory<
    TConfig,
    {
      node: NodeStorageProfile;
      runtime: RuntimeStorageProfile<TContext>;
    }
  >;
};

const wrapStorageUpload = <TContext>(
  implementation: StoragePluginCore<TContext>,
  hooks?: StoragePluginHooks,
): NonNullable<StoragePluginCore<TContext>["upload"]> => {
  return async (key, source, context) => {
    const result = await implementation.upload?.(key, source, context);
    if (!result) {
      throw new Error("Storage plugin does not implement upload.");
    }

    await hooks?.onStorageUploaded?.();
    return result;
  };
};

export const createStoragePlugin = <TConfig, TContext = unknown>(
  options: CreateStoragePluginOptions<TConfig, TContext>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): StoragePlugin<TContext> => {
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

const createMissingProfileError = (
  name: string,
  supportedProtocol: string,
  profile: string,
) =>
  new Error(
    `${name} does not implement the ${profile} storage profile for protocol "${supportedProtocol}".`,
  );

const createLazyNodeProfile = ({
  createNode,
  hooks,
  name,
  supportedProtocol,
}: {
  createNode: () => NodeStorageProfile | undefined;
  hooks?: StoragePluginHooks;
  name: string;
  supportedProtocol: string;
}): NodeStorageProfile => {
  let cachedNodeProfile: NodeStorageProfile | undefined;

  const requireNodeProfile = () => {
    cachedNodeProfile ??= createNode();
    if (!cachedNodeProfile) {
      throw createMissingProfileError(name, supportedProtocol, "node");
    }

    return cachedNodeProfile;
  };

  return {
    async delete(storageUri) {
      return requireNodeProfile().delete(storageUri);
    },
    async downloadFile(storageUri, filePath) {
      return requireNodeProfile().downloadFile(storageUri, filePath);
    },
    async exists(storageUri) {
      return requireNodeProfile().exists(storageUri);
    },
    async upload(key, filePath) {
      const result = await requireNodeProfile().upload(key, filePath);
      await hooks?.onStorageUploaded?.();
      return result;
    },
  };
};

const createLazyRuntimeProfile = <TContext>({
  createRuntime,
  name,
  supportedProtocol,
}: {
  createRuntime: () => RuntimeStorageProfile<TContext> | undefined;
  name: string;
  supportedProtocol: string;
}): RuntimeStorageProfile<TContext> => {
  let cachedRuntimeProfile: RuntimeStorageProfile<TContext> | undefined;

  const requireRuntimeProfile = () => {
    cachedRuntimeProfile ??= createRuntime();
    if (!cachedRuntimeProfile) {
      throw createMissingProfileError(name, supportedProtocol, "runtime");
    }

    return cachedRuntimeProfile;
  };

  return {
    async getDownloadUrl(storageUri, context) {
      return requireRuntimeProfile().getDownloadUrl(storageUri, context);
    },
    async readText(storageUri, context) {
      return requireRuntimeProfile().readText(storageUri, context);
    },
  };
};

export const createNodeStoragePlugin = <TConfig>(
  options: CreateNodeStoragePluginOptions<TConfig>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): NodeStoragePlugin => ({
      name: options.name,
      supportedProtocol: options.supportedProtocol,
      profiles: {
        node: createLazyNodeProfile({
          createNode: () => options.factory(config),
          hooks,
          name: options.name,
          supportedProtocol: options.supportedProtocol,
        }),
      },
    });
  };
};

export const createRuntimeStoragePlugin = <TConfig, TContext = unknown>(
  options: CreateRuntimeStoragePluginOptions<TConfig, TContext>,
) => {
  return (config: TConfig) => {
    return (): RuntimeStoragePlugin<TContext> => ({
      name: options.name,
      supportedProtocol: options.supportedProtocol,
      profiles: {
        runtime: createLazyRuntimeProfile({
          createRuntime: () => options.factory(config),
          name: options.name,
          supportedProtocol: options.supportedProtocol,
        }),
      },
    });
  };
};

export const createUniversalStoragePlugin = <TConfig, TContext = unknown>(
  options: CreateUniversalStoragePluginOptions<TConfig, TContext>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): UniversalStoragePlugin<TContext> => {
      let cachedProfiles:
        | {
            node: NodeStorageProfile;
            runtime: RuntimeStorageProfile<TContext>;
          }
        | undefined;

      const getProfiles = () => {
        cachedProfiles ??= options.factory(config);
        return cachedProfiles;
      };

      return {
        name: options.name,
        supportedProtocol: options.supportedProtocol,
        profiles: {
          node: createLazyNodeProfile({
            createNode: () => getProfiles().node,
            hooks,
            name: options.name,
            supportedProtocol: options.supportedProtocol,
          }),
          runtime: createLazyRuntimeProfile({
            createRuntime: () => getProfiles().runtime,
            name: options.name,
            supportedProtocol: options.supportedProtocol,
          }),
        },
      };
    };
  };
};
