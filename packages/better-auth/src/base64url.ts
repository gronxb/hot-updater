const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const isCanonicalBase64Url32 = (value: string): boolean => {
  if (!BASE64URL_32_PATTERN.test(value)) return false;

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(`${base64}=`);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const canonical = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    return bytes.byteLength === 32 && canonical === value;
  } catch {
    return false;
  }
};
