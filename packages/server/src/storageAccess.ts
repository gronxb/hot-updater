import type {
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";

const assertRemoteDownloadUrl = (fileUrl: string) => {
  if (URL.canParse(fileUrl)) {
    const protocol = new URL(fileUrl).protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return fileUrl;
    }
  }

  throw new Error(
    "Storage plugin returned a local file path; runtime update checks require an HTTP(S) download URL.",
  );
};

const getStorageProtocol = (storageUri: string) => {
  try {
    return new URL(storageUri).protocol.replace(":", "");
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid storage URI: ${storageUri}`);
    }
    throw error;
  }
};

const isRemoteUrlProtocol = (protocol: string) =>
  protocol === "http" || protocol === "https";

export const createStorageAccess = <TContext>(
  storagePlugins: readonly RuntimeStoragePlugin<TContext>[],
) => {
  const pluginsByProtocol = new Map<string, RuntimeStoragePlugin<TContext>>();
  for (const plugin of storagePlugins) {
    const protocol = plugin.supportedProtocol.toLowerCase();
    const existing = pluginsByProtocol.get(protocol);
    if (existing) {
      throw new Error(
        `Duplicate storage protocol "${protocol}" from plugins "${existing.name}" and "${plugin.name}".`,
      );
    }
    pluginsByProtocol.set(protocol, plugin);
  }

  const findStoragePlugin = (protocol: string) => {
    return pluginsByProtocol.get(protocol.toLowerCase());
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
      const downloadTarget = await plugin.profiles.runtime.getDownloadUrl(
        storageUri,
        context,
      );
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
      return plugin.profiles.runtime.readText(storageUri, context);
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
