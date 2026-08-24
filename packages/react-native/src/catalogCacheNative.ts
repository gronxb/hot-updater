import HotUpdaterNative from "./specs/NativeHotUpdater";

type CatalogCacheNativeModule = {
  getReleaseCatalogCache?: (partition: string) => Promise<string | null>;
  removeReleaseCatalogCache?: (partition: string) => Promise<boolean>;
  setReleaseCatalogCache?: (
    partition: string,
    payload: string,
  ) => Promise<boolean>;
};

type CatalogCacheNativeMethodName = keyof CatalogCacheNativeModule;

const getModule = () =>
  HotUpdaterNative as typeof HotUpdaterNative & CatalogCacheNativeModule;

const requireMethod = <T>(
  method: T | undefined,
  name: CatalogCacheNativeMethodName,
): T => {
  if (typeof method !== "function") {
    throw new Error(
      `[HotUpdater] Native module is missing '${name}()'. Rebuild the native app before using Release catalogs.`,
    );
  }
  return method;
};

export const readNativeReleaseCatalogCache = async (
  partition: string,
): Promise<string | null> => {
  const method = requireMethod(
    getModule().getReleaseCatalogCache,
    "getReleaseCatalogCache",
  );

  try {
    const value = await method.call(HotUpdaterNative, partition);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

export const writeNativeReleaseCatalogCache = async (
  partition: string,
  payload: string,
): Promise<boolean> => {
  const method = requireMethod(
    getModule().setReleaseCatalogCache,
    "setReleaseCatalogCache",
  );

  try {
    return await method.call(HotUpdaterNative, partition, payload);
  } catch {
    return false;
  }
};

export const removeNativeReleaseCatalogCache = async (
  partition: string,
): Promise<void> => {
  const method = requireMethod(
    getModule().removeReleaseCatalogCache,
    "removeReleaseCatalogCache",
  );

  try {
    await method.call(HotUpdaterNative, partition);
  } catch {
    // Cache maintenance must not prevent a network update check.
  }
};
