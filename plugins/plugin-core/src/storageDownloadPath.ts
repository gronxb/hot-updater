const encodeBase64Url = (value: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const decodeBase64Url = (value: string) => {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return new TextDecoder(undefined, { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
};

const encodeBytes = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

export const createStorageDownloadPath = (
  storageUri: string,
  signature: string,
) => `/storage/${encodeBase64Url(storageUri)}/${encodeURIComponent(signature)}`;

export const parseStorageDownloadPath = (path: string) => {
  const match = /^\/storage\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  const storageUri = decodeBase64Url(match[1]);
  if (storageUri === null) return null;
  try {
    return {
      signature: decodeURIComponent(match[2]),
      storageUri,
    };
  } catch {
    return null;
  }
};

export const createStorageDownloadUrl = (signingKey: string) => {
  const key = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

  return async ({ storageUri }: { readonly storageUri: string }) => {
    const signature = encodeBytes(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await key,
          new TextEncoder().encode(storageUri),
        ),
      ),
    );
    return { url: createStorageDownloadPath(storageUri, signature) };
  };
};
