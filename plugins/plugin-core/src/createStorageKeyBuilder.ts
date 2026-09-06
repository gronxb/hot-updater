export const createStorageKeyBuilder =
  (basePath: string | undefined) =>
  (...args: string[]) => {
    // Surrounding slashes would emit an empty key segment, and the asset
    // storage URI resolver drops empty segments when it rebuilds those keys.
    const normalizedBasePath = basePath?.replace(/^\/+|\/+$/g, "") ?? "";
    return [normalizedBasePath, ...args].filter(Boolean).join("/");
  };
