import type { StorageAdapter } from "@hot-updater/plugin-core";

/** A URL devices download from, which only an absolute HTTP(S) URL can be. */
const assertRemoteUrl = (value: string) => {
  let protocol: string | undefined;
  try {
    protocol = new URL(value).protocol;
  } catch {
    // A path, which no device can download from.
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(
      "Storage getDownloadUrl must resolve to an absolute HTTP(S) URL.",
    );
  }
  return value;
};

const getStorageProtocol = (storageUri: string) =>
  new URL(storageUri).protocol.replace(":", "");

const isRemoteUrlProtocol = (protocol: string) =>
  protocol === "http" || protocol === "https";

/**
 * Reads and download URLs over the server's storage, for the URIs of its
 * protocol; an HTTP(S) URI is used as it is.
 */
export const createStorageAccess = (storageAdapter: StorageAdapter) => {
  const findStorage = (protocol: string) =>
    storageAdapter.protocol === protocol ? storageAdapter : undefined;

  const readStorageResponse = async (
    storageUri: string,
  ): Promise<Response | null> => {
    const protocol = getStorageProtocol(storageUri);
    const storage = findStorage(protocol);
    if (storage) {
      // Storage that only uploads, as the CLI's credentials for a managed
      // server allow, gives no file: core then resolves no artifacts, and
      // `handlers` refuses to serve with it.
      if (!storage.get) return null;
      return (await storage.get({ storageUri })).response;
    }

    if (isRemoteUrlProtocol(protocol)) {
      const response = await fetch(storageUri);
      return response.ok ? response : null;
    }

    throw new Error(`No storage adapter for protocol: ${protocol}`);
  };

  const resolveFileUrl = async (
    storageUri: string | null,
  ): Promise<string | null> => {
    if (!storageUri) return null;

    const protocol = getStorageProtocol(storageUri);
    const storage = findStorage(protocol);
    if (!storage) {
      if (isRemoteUrlProtocol(protocol)) return storageUri;
      throw new Error(`No storage adapter for protocol: ${protocol}`);
    }
    // Nor a URL to sign.
    if (!storage.getDownloadUrl) return null;
    const { url: downloadUrl } = await storage.getDownloadUrl({ storageUri });
    return assertRemoteUrl(downloadUrl);
  };

  const readStorageText = async (
    storageUri: string,
  ): Promise<string | null> => {
    const response = await readStorageResponse(storageUri);
    return response?.text() ?? null;
  };

  return {
    readStorageText,
    resolveFileUrl,
  };
};
