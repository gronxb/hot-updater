const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

function utf8ByteLength(value: string): number | null {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      length += 1;
    } else if (code <= 0x7ff) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return null;
      length += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    } else {
      length += 3;
    }
  }
  return length;
}

/**
 * Qualifies a verified managed-resource URL for one native runtime generation.
 * Lynx may cache font sources for the process lifetime, while Hot Updater can
 * replace every managed runtime without replacing that process.
 */
export function managedResourceUrl(
  relativePath: string,
  runtimeGenerationEpoch: string,
): string {
  const hasForbiddenCharacter = Array.from(relativePath).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    !POSITIVE_DECIMAL.test(runtimeGenerationEpoch) ||
    relativePath.trim().length === 0 ||
    (utf8ByteLength(relativePath) ?? 1025) > 1024 ||
    hasForbiddenCharacter ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    /[\\%?#:]/.test(relativePath) ||
    relativePath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Invalid managed resource URL input");
  }
  return (
    `hot-updater:///${relativePath}` +
    `?hot-updater-generation=${runtimeGenerationEpoch}`
  );
}
