import HotUpdaterNative from "./specs/NativeHotUpdater";

type CatalogCacheNativeModule = {
  getReleaseCatalogCache?: (partition: string) => Promise<string | null>;
  removeReleaseCatalogCache?: (partition: string) => Promise<boolean>;
  setReleaseCatalogCache?: (
    partition: string,
    payload: string,
  ) => Promise<boolean>;
};

const getModule = () =>
  HotUpdaterNative as typeof HotUpdaterNative & CatalogCacheNativeModule;

export const readNativeReleaseCatalogCache = async (
  partition: string,
): Promise<string | null> => {
  const method = getModule().getReleaseCatalogCache;
  if (typeof method !== "function") return null;

  try {
    return await method.call(HotUpdaterNative, partition);
  } catch {
    return null;
  }
};

export const writeNativeReleaseCatalogCache = async (
  partition: string,
  payload: string,
): Promise<boolean> => {
  const method = getModule().setReleaseCatalogCache;
  if (typeof method !== "function") return false;

  try {
    return await method.call(HotUpdaterNative, partition, payload);
  } catch {
    return false;
  }
};

export const removeNativeReleaseCatalogCache = async (
  partition: string,
): Promise<void> => {
  const method = getModule().removeReleaseCatalogCache;
  if (typeof method !== "function") return;

  try {
    await method.call(HotUpdaterNative, partition);
  } catch {
    // Cache maintenance must not prevent a network update check.
  }
};
