const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export const encodeBase64Url = (bytes: Uint8Array): string => {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const decodeBase64Url = (value: string): Uint8Array | undefined => {
  if (!BASE64URL_PATTERN.test(value)) return undefined;

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(`${base64}${padding}`);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return encodeBase64Url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};

export const decodeBase64Url32 = (value: string): Uint8Array | undefined => {
  const bytes = decodeBase64Url(value);
  return bytes?.byteLength === 32 ? bytes : undefined;
};
