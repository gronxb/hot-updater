import {
  MAX_BUNDLE_MANIFEST_BYTES,
  parseStorageDownloadPath,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

import { readBoundedResponseBytes } from "./boundedResponseBody";

const assertRemoteUrl = (value: string) => {
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

const resolveDownloadPath = (value: string, storageUri: string) => {
  const parsed = parseStorageDownloadPath(value);
  if (!parsed || parsed.storageUri !== storageUri) {
    throw new Error(
      "Storage getDownloadUrl must return an HTTP(S) URL or a valid storage download path.",
    );
  }
  return value;
};

const tokensEqual = (left: string, right: string) => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

export const createStorageAccess = (
  storagePlugins: StoragePluginWith<"get">[],
) => {
  const protocols = new Set<string>();
  for (const storage of storagePlugins) {
    if (protocols.has(storage.protocol)) {
      throw new Error(
        `Multiple storage plugins handle protocol: ${storage.protocol}`,
      );
    }
    protocols.add(storage.protocol);
  }

  const findStorage = (protocol: string) =>
    storagePlugins.find((item) => item.protocol === protocol);

  const readStorageResponse = async (
    storageUri: string,
  ): Promise<Response | null> => {
    const protocol = getStorageProtocol(storageUri);
    const storage = findStorage(protocol);
    if (storage) return (await storage.get({ storageUri })).response;

    if (isRemoteUrlProtocol(protocol)) {
      const response = await fetch(storageUri);
      return response.ok ? response : null;
    }

    throw new Error(`No storage plugin for protocol: ${protocol}`);
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
      if (directRemoteUrl !== null) return directRemoteUrl;
      throw new Error(`No storage plugin for protocol: ${protocol}`);
    }
    if (!storage.getDownloadUrl) {
      throw new Error(
        `Storage plugin "${storage.name}" does not implement getDownloadUrl.`,
      );
    }
    const { url: downloadUrl } = await storage.getDownloadUrl({ storageUri });
    try {
      return assertRemoteUrl(downloadUrl);
    } catch (error) {
      if (/^[a-z][a-z\d+.-]*:/i.test(downloadUrl)) throw error;
    }
    return resolveDownloadPath(downloadUrl, storageUri);
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

  const downloadStorageObject = storagePlugins.some(
    (storage) => storage.getDownloadUrl !== undefined,
  )
    ? async (
        storageUriToken: string,
        encodedSignature: string,
      ): Promise<Response | null> => {
        const requestedPath = `/storage/${storageUriToken}/${encodedSignature}`;
        const requested = parseStorageDownloadPath(requestedPath);
        if (!requested) return null;
        let storage: StoragePluginWith<"get"> | undefined;
        try {
          storage = findStorage(getStorageProtocol(requested.storageUri));
        } catch {
          return null;
        }
        if (!storage?.getDownloadUrl) return null;
        const { url: downloadUrl } = await storage.getDownloadUrl({
          storageUri: requested.storageUri,
        });
        try {
          new URL(downloadUrl);
          return null;
        } catch {
          if (/^[a-z][a-z\d+.-]*:/i.test(downloadUrl)) return null;
        }
        if (!tokensEqual(downloadUrl, requestedPath)) return null;
        return (await storage.get({ storageUri: requested.storageUri }))
          .response;
      }
    : undefined;

  return {
    downloadStorageObject,
    readStorageText,
    resolveFileUrl,
  };
};
