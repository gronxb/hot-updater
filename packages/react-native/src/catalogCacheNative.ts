import HotUpdaterNative from "./specs/NativeHotUpdater";

export const readNativeReleaseCatalogCache = async (
  partition: string,
): Promise<string | null> => {
  try {
    const value: unknown =
      await HotUpdaterNative.getReleaseCatalogCache(partition);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

export const writeNativeReleaseCatalogCache = async (
  partition: string,
  payload: string,
): Promise<boolean> => {
  try {
    return await HotUpdaterNative.setReleaseCatalogCache(partition, payload);
  } catch {
    return false;
  }
};

export const removeNativeReleaseCatalogCache = async (
  partition: string,
): Promise<void> => {
  try {
    await HotUpdaterNative.removeReleaseCatalogCache(partition);
  } catch {
    // Cache maintenance must not prevent a network update check.
  }
};
