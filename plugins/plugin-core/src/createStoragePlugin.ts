import type {
  NodeStoragePlugin,
  NodeStorageProfile,
  RuntimeStoragePlugin,
  RuntimeStorageProfile,
  StoragePlugin,
  StoragePluginHooks,
  StoragePluginProfiles,
  UniversalStoragePlugin,
} from "./types";

type StorageProfileFactory<TConfig, TProfiles> = (config: TConfig) => TProfiles;

interface BaseStoragePluginOptions<
  TConfig,
  TContext = unknown,
  TProfiles extends StoragePluginProfiles<TContext> =
    StoragePluginProfiles<TContext>,
> {
  /**
   * The name of the storage plugin (e.g., "s3Storage", "r2Storage").
   */
  name: string;
  /**
   * The protocol that this storage plugin supports (e.g., "s3", "r2", "gs").
   *
   * This value is stored in the database and is used by the server to
   * understand how to fetch assets.
   */
  supportedProtocol: string;
  /**
   * Function that creates the storage plugin profiles.
   */
  factory: StorageProfileFactory<TConfig, TProfiles>;
}

type CreateNodeStoragePluginOptions<TConfig> = Omit<
  BaseStoragePluginOptions<TConfig, unknown, { node: NodeStorageProfile }>,
  "factory"
> & {
  factory: StorageProfileFactory<TConfig, NodeStorageProfile>;
};

type CreateRuntimeStoragePluginOptions<TConfig, TContext = unknown> = Omit<
  BaseStoragePluginOptions<
    TConfig,
    TContext,
    { runtime: RuntimeStorageProfile<TContext> }
  >,
  "factory"
> & {
  factory: StorageProfileFactory<TConfig, RuntimeStorageProfile<TContext>>;
};

type CreateUniversalStoragePluginOptions<TConfig, TContext = unknown> = Omit<
  BaseStoragePluginOptions<
    TConfig,
    TContext,
    {
      node: NodeStorageProfile;
      runtime: RuntimeStorageProfile<TContext>;
    }
  >,
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

const wrapNodeProfile = (
  node: NodeStorageProfile,
  hooks?: StoragePluginHooks,
): NodeStorageProfile => ({
  ...node,
  async upload(key, filePath) {
    const result = await node.upload(key, filePath);
    await hooks?.onStorageUploaded?.();
    return result;
  },
});

const createProfiledStoragePlugin = <TContext>(
  {
    createProfiles,
    name,
    profileShape,
    supportedProtocol,
  }: {
    createProfiles: () => StoragePluginProfiles<TContext>;
    name: string;
    profileShape?: {
      node?: boolean;
      runtime?: boolean;
    };
    supportedProtocol: string;
  },
  hooks?: StoragePluginHooks,
): StoragePlugin<TContext> => {
  let cachedProfiles: StoragePluginProfiles<TContext> | null = null;
  let cachedNodeProfile: NodeStorageProfile | undefined;
  let cachedRuntimeProfile: RuntimeStorageProfile<TContext> | undefined;

  const getProfiles = () => {
    cachedProfiles ??= createProfiles();
    return cachedProfiles;
  };

  const getNodeProfile = () => {
    const node = getProfiles().node;
    if (!node) {
      return undefined;
    }

    cachedNodeProfile ??= wrapNodeProfile(node, hooks);
    return cachedNodeProfile;
  };

  const requireNodeProfile = () => {
    const node = getNodeProfile();
    if (!node) {
      throw new Error(
        `${name} does not implement the node storage profile for protocol "${supportedProtocol}".`,
      );
    }

    return node;
  };

  const getRuntimeProfile = () => {
    const runtime = getProfiles().runtime;
    if (!runtime) {
      return undefined;
    }

    cachedRuntimeProfile ??= runtime;
    return cachedRuntimeProfile;
  };

  const requireRuntimeProfile = () => {
    const runtime = getRuntimeProfile();
    if (!runtime) {
      throw new Error(
        `${name} does not implement the runtime storage profile for protocol "${supportedProtocol}".`,
      );
    }

    return runtime;
  };

  const profiles = {} as StoragePluginProfiles<TContext>;

  if (profileShape?.node) {
    profiles.node = {
      async delete(storageUri) {
        return requireNodeProfile().delete(storageUri);
      },
      async downloadFile(storageUri, filePath) {
        return requireNodeProfile().downloadFile(storageUri, filePath);
      },
      async upload(key, filePath) {
        return requireNodeProfile().upload(key, filePath);
      },
    };
  } else if (profileShape?.node !== false) {
    Object.defineProperty(profiles, "node", {
      enumerable: true,
      get: getNodeProfile,
    });
  }

  if (profileShape?.runtime) {
    profiles.runtime = {
      async getDownloadUrl(storageUri, context) {
        return requireRuntimeProfile().getDownloadUrl(storageUri, context);
      },
      async readText(storageUri, context) {
        return requireRuntimeProfile().readText(storageUri, context);
      },
    };
  } else if (profileShape?.runtime !== false) {
    Object.defineProperty(profiles, "runtime", {
      enumerable: true,
      get: getRuntimeProfile,
    });
  }

  return {
    name,
    supportedProtocol,
    profiles,
  };
};

/**
 * Creates a deploy/CLI/console storage plugin.
 */
export const createNodeStoragePlugin = <TConfig>(
  options: CreateNodeStoragePluginOptions<TConfig>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): NodeStoragePlugin =>
      createProfiledStoragePlugin(
        {
          createProfiles: () => ({ node: options.factory(config) }),
          name: options.name,
          profileShape: {
            node: true,
            runtime: false,
          },
          supportedProtocol: options.supportedProtocol,
        },
        hooks,
      ) as NodeStoragePlugin;
  };
};

/**
 * Creates an update-check runtime storage plugin.
 */
export const createRuntimeStoragePlugin = <TConfig, TContext = unknown>(
  options: CreateRuntimeStoragePluginOptions<TConfig, TContext>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): RuntimeStoragePlugin<TContext> =>
      createProfiledStoragePlugin(
        {
          createProfiles: () => ({ runtime: options.factory(config) }),
          name: options.name,
          profileShape: {
            node: false,
            runtime: true,
          },
          supportedProtocol: options.supportedProtocol,
        },
        hooks,
      ) as RuntimeStoragePlugin<TContext>;
  };
};

/**
 * Creates a storage plugin that can be used by both Node tooling and update
 * check runtimes.
 */
export const createUniversalStoragePlugin = <TConfig, TContext = unknown>(
  options: CreateUniversalStoragePluginOptions<TConfig, TContext>,
) => {
  return (config: TConfig, hooks?: StoragePluginHooks) => {
    return (): UniversalStoragePlugin<TContext> =>
      createProfiledStoragePlugin(
        {
          createProfiles: () => options.factory(config),
          name: options.name,
          profileShape: {
            node: true,
            runtime: true,
          },
          supportedProtocol: options.supportedProtocol,
        },
        hooks,
      ) as UniversalStoragePlugin<TContext>;
  };
};
