export const createStorageKeyBuilder =
  (basePath: string | undefined) =>
  (...args: string[]) => {
    return [basePath || "", ...args].filter(Boolean).join("/");
  };
