import {
  parseStorageDownloadPath,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

const assertRemoteUrl = (value: string) => {
  const protocol = new URL(value).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("Storage getDownloadUrl must resolve to an HTTP(S) URL.");
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

const withBasePath = (basePath: string, downloadPath: string) => {
  const handlerPath = basePath === "/" ? "" : basePath;
  return `${handlerPath}${downloadPath}`;
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
  options: { readonly basePath: string },
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

    const protocol = getStorageProtocol(storageUri);
    if (isRemoteUrlProtocol(protocol)) return storageUri;
    const storage = findStorage(protocol);
    if (!storage) {
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
    return withBasePath(
      options.basePath,
      resolveDownloadPath(downloadUrl, storageUri),
    );
  };

  const readStorageText = async (
    storageUri: string,
  ): Promise<string | null> => {
    const response = await readStorageResponse(storageUri);
    return response?.text() ?? null;
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
