import {
  MAX_BUNDLE_MANIFEST_BYTES,
  type StorageAdapter,
} from "@hot-updater/plugin-core";

import { readBoundedResponseBytes } from "./boundedResponseBody";

const assertRemoteUrl = (value: string) => {
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(
      "Storage getDownloadUrl must resolve to an absolute HTTP(S) URL.",
    );
  }
  const match =
    /^https?:\/\/(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(?:[/?#].*)?$/i.exec(
      value,
    );
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || value[index] === "\\") {
      throw new Error(
        "Storage getDownloadUrl must resolve to a safe HTTP(S) URL.",
      );
    }
  }
  if (!match || (match[2] !== undefined && Number(match[2]) > 65_535)) {
    throw new Error(
      "Storage getDownloadUrl must resolve to a safe HTTP(S) URL.",
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

    const directRemoteUrl = /^https?:/i.test(storageUri)
      ? assertRemoteUrl(storageUri)
      : null;
    const protocol = getStorageProtocol(directRemoteUrl ?? storageUri);
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
    return response
      ? new TextDecoder().decode(
          await readBoundedResponseBytes(response, MAX_BUNDLE_MANIFEST_BYTES),
        )
      : null;
  };

  return {
    readStorageText,
    resolveFileUrl,
  };
};
