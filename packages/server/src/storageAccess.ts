import type {
  HotUpdaterContext,
  RuntimeStoragePlugin,
  RuntimeStorageProfile,
} from "@hot-updater/plugin-core";

const runtimeStorageRegistryKey = Symbol.for(
  "@hot-updater/internal/storage-runtime-registry",
);

type RuntimeStorageDescriptor<TContext> = Readonly<{
  getImplementation(): RuntimeStorageProfile<TContext>;
}>;

type RuntimeStorageRegistry = WeakMap<
  object,
  RuntimeStorageDescriptor<unknown>
>;

const getRuntimeStorageImplementation = <TContext>(
  plugin: object,
): (() => RuntimeStorageProfile<TContext>) | undefined => {
  const scope = globalThis as typeof globalThis & {
    [runtimeStorageRegistryKey]?: RuntimeStorageRegistry;
  };
  const descriptor = scope[runtimeStorageRegistryKey]?.get(plugin);
  if (descriptor === undefined) return undefined;
  return descriptor.getImplementation as () => RuntimeStorageProfile<TContext>;
};

export type RuntimeStorageRecord<TContext> = Readonly<{
  getDownloadUrl(
    storageUri: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<{ readonly fileUrl: string }>;
  name: string;
  readText(
    storageUri: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<string | null>;
  supportedProtocol: string;
}>;

const createRuntimeStorageRecord = <TContext>(
  plugin: RuntimeStoragePlugin<TContext>,
  getImplementation: () => RuntimeStorageProfile<TContext>,
): RuntimeStorageRecord<TContext> =>
  Object.freeze({
    getDownloadUrl: (storageUri, context) =>
      getImplementation().getDownloadUrl(storageUri, context),
    name: plugin.name,
    readText: (storageUri, context) =>
      getImplementation().readText(storageUri, context),
    supportedProtocol: plugin.supportedProtocol,
  });

export const createRuntimeStorageRecords = <TContext>(
  plugins: readonly RuntimeStoragePlugin<TContext>[],
): readonly RuntimeStorageRecord<TContext>[] =>
  Object.freeze(
    plugins.map((plugin) =>
      createRuntimeStorageRecord(
        plugin,
        getRuntimeStorageImplementation<TContext>(plugin) ??
          (() => plugin.profiles.runtime),
      ),
    ),
  );

const assertRemoteDownloadUrl = (fileUrl: string) => {
  try {
    const protocol = new URL(fileUrl).protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return fileUrl;
    }
  } catch {
    // Fall through to the runtime-specific error below.
  }

  throw new Error(
    "Storage plugin returned a local file path; runtime update checks require an HTTP(S) download URL.",
  );
};

const getStorageProtocol = (storageUri: string) =>
  new URL(storageUri).protocol.replace(":", "");

const isRemoteUrlProtocol = (protocol: string) =>
  protocol === "http" || protocol === "https";

export const createStorageAccess = <TContext>(
  storagePlugins: readonly RuntimeStorageRecord<TContext>[],
) => {
  const findStoragePlugin = (protocol: string) => {
    return storagePlugins.find((item) => item.supportedProtocol === protocol);
  };

  const resolveFileUrl = async (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
  ): Promise<string | null> => {
    if (!storageUri) {
      return null;
    }

    const protocol = getStorageProtocol(storageUri);
    const plugin = findStoragePlugin(protocol);
    if (plugin) {
      const downloadTarget = await plugin.getDownloadUrl(storageUri, context);
      const { fileUrl } = downloadTarget;
      if (!fileUrl) {
        throw new Error("Storage plugin returned empty fileUrl");
      }

      return assertRemoteDownloadUrl(fileUrl);
    }

    if (isRemoteUrlProtocol(protocol)) {
      return storageUri;
    }

    throw new Error(`No storage plugin for protocol: ${protocol}`);
  };

  const readStorageText = async (
    storageUri: string,
    context?: HotUpdaterContext<TContext>,
  ): Promise<string | null> => {
    const protocol = getStorageProtocol(storageUri);
    const plugin = findStoragePlugin(protocol);
    if (plugin) {
      return plugin.readText(storageUri, context);
    }

    if (isRemoteUrlProtocol(protocol)) {
      const response = await fetch(storageUri);
      if (!response.ok) {
        return null;
      }

      return response.text();
    }

    throw new Error(`No storage plugin for protocol: ${protocol}`);
  };

  return {
    readStorageText,
    resolveFileUrl,
  };
};
