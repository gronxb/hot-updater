import type {
  HotUpdaterContext,
  RuntimeStorageOperations,
} from "@hot-updater/plugin-core";

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
  storagePlugins: RuntimeStorageOperations<TContext>[],
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
