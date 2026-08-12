import type { StoragePluginWith } from "@hot-updater/plugin-core";

export interface StorageDeliveryOptions {
  /** Public URL of the server that mounts `createHotUpdater().handler`. */
  readonly publicBaseUrl?: string;
  /** HMAC key used to prevent callers from forging storage delivery URLs. */
  readonly signingKey?: string;
  /** Optional provider/CDN URL resolver. Return null to use server delivery. */
  readonly resolveUrl?: (
    storageUri: string,
  ) => string | null | Promise<string | null>;
}

const assertRemoteUrl = (value: string) => {
  const protocol = new URL(value).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("Storage delivery must resolve to an HTTP(S) URL.");
  }
  return value;
};

const getStorageProtocol = (storageUri: string) =>
  new URL(storageUri).protocol.replace(":", "");

const isRemoteUrlProtocol = (protocol: string) =>
  protocol === "http" || protocol === "https";

const encodeStorageUri = (storageUri: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(storageUri)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const decodeStorageUri = (token: string) => {
  try {
    const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return new TextDecoder(undefined, { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
};

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const decodeBase64Url = (value: string) => {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const importSigningKey = (signingKey: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );

const signToken = async (token: string, signingKey: string) =>
  encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await importSigningKey(signingKey),
        new TextEncoder().encode(token),
      ),
    ),
  );

const verifyToken = async (
  token: string,
  signature: string,
  signingKey: string,
) => {
  const signatureBytes = decodeBase64Url(signature);
  if (!signatureBytes) return false;
  return crypto.subtle.verify(
    "HMAC",
    await importSigningKey(signingKey),
    signatureBytes,
    new TextEncoder().encode(token),
  );
};

const createDeliveryUrl = async (
  publicBaseUrl: string,
  basePath: string,
  storageUri: string,
  signingKey: string,
) => {
  const token = encodeStorageUri(storageUri);
  const signature = await signToken(token, signingKey);
  const url = new URL(publicBaseUrl);
  const publicPath = url.pathname.replace(/\/+$/, "");
  const handlerPath = basePath === "/" ? "" : basePath;
  url.pathname = `${publicPath}${handlerPath}/storage/${token}/${signature}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const createStorageAccess = (
  storages: StoragePluginWith<"get">[],
  options: StorageDeliveryOptions & { readonly basePath: string },
) => {
  const protocols = new Set<string>();
  for (const storage of storages) {
    if (protocols.has(storage.protocol)) {
      throw new Error(
        `Multiple storage plugins handle protocol: ${storage.protocol}`,
      );
    }
    protocols.add(storage.protocol);
  }

  const findStorage = (protocol: string) =>
    storages.find((item) => item.protocol === protocol);

  const readStorageResponse = async (
    storageUri: string,
  ): Promise<Response | null> => {
    const protocol = getStorageProtocol(storageUri);
    const storage = findStorage(protocol);
    if (storage) return storage.get(storageUri);

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
    if (!findStorage(protocol)) {
      throw new Error(`No storage plugin for protocol: ${protocol}`);
    }

    const resolved = await options.resolveUrl?.(storageUri);
    if (resolved) return assertRemoteUrl(resolved);
    if (!options.publicBaseUrl || !options.signingKey) {
      throw new Error(
        "Storage delivery requires publicBaseUrl with signingKey, or resolveUrl in createHotUpdater().",
      );
    }
    return createDeliveryUrl(
      options.publicBaseUrl,
      options.basePath,
      storageUri,
      options.signingKey,
    );
  };

  const readStorageText = async (
    storageUri: string,
  ): Promise<string | null> => {
    const response = await readStorageResponse(storageUri);
    return response?.text() ?? null;
  };

  const publicBaseUrl = options.publicBaseUrl;
  const signingKey = options.signingKey;
  const downloadStorageObject =
    publicBaseUrl && signingKey
      ? async (token: string, signature: string): Promise<Response | null> => {
          if (!(await verifyToken(token, signature, signingKey))) {
            return null;
          }
          const storageUri = decodeStorageUri(token);
          return storageUri === null ? null : readStorageResponse(storageUri);
        }
      : undefined;

  return {
    downloadStorageObject,
    readStorageText,
    resolveFileUrl,
  };
};
