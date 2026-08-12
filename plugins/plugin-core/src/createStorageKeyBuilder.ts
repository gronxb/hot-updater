const normalizeStorageKeyParts = (values: readonly string[]) => {
  if (values.some((value) => value.includes("\\"))) {
    throw new Error("Storage keys must use '/' as the hierarchy separator.");
  }
  const segments = values.flatMap((value) => value.split("/").filter(Boolean));
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Storage key segments must not be '.' or '..'.");
  }
  return segments;
};

export const createStorageKeyBuilder = (basePath: string | undefined) => {
  const baseSegments = normalizeStorageKeyParts([basePath ?? ""]);
  return (...args: string[]) =>
    [...baseSegments, ...normalizeStorageKeyParts(args)].join("/");
};
