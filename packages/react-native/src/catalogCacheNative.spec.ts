import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(
  () => ({}) as Record<string, ReturnType<typeof vi.fn>>,
);

vi.mock("./specs/NativeHotUpdater", () => ({ default: nativeModule }));

import {
  readNativeReleaseCatalogCache,
  removeNativeReleaseCatalogCache,
  writeNativeReleaseCatalogCache,
} from "./catalogCacheNative";

describe("Release Catalog native cache", () => {
  beforeEach(() => {
    for (const key of Object.keys(nativeModule)) delete nativeModule[key];
  });

  it("fails fast when the v1 native cache API is missing", async () => {
    await expect(readNativeReleaseCatalogCache("partition")).rejects.toThrow(
      "Native module is missing 'getReleaseCatalogCache()'. Rebuild the native app before using Release catalogs.",
    );
    await expect(
      writeNativeReleaseCatalogCache("partition", "payload"),
    ).rejects.toThrow(
      "Native module is missing 'setReleaseCatalogCache()'. Rebuild the native app before using Release catalogs.",
    );
    await expect(removeNativeReleaseCatalogCache("partition")).rejects.toThrow(
      "Native module is missing 'removeReleaseCatalogCache()'. Rebuild the native app before using Release catalogs.",
    );
  });

  it("normalizes an undefined iOS TurboModule cache miss to null", async () => {
    nativeModule.getReleaseCatalogCache = vi.fn().mockResolvedValue(undefined);

    await expect(
      readNativeReleaseCatalogCache("partition"),
    ).resolves.toBeNull();
  });

  it("treats native cache I/O failures as misses without hiding network work", async () => {
    nativeModule.getReleaseCatalogCache = vi
      .fn()
      .mockRejectedValue(new Error("read"));
    nativeModule.setReleaseCatalogCache = vi
      .fn()
      .mockRejectedValue(new Error("write"));
    nativeModule.removeReleaseCatalogCache = vi
      .fn()
      .mockRejectedValue(new Error("remove"));

    await expect(
      readNativeReleaseCatalogCache("partition"),
    ).resolves.toBeNull();
    await expect(
      writeNativeReleaseCatalogCache("partition", "payload"),
    ).resolves.toBe(false);
    await expect(
      removeNativeReleaseCatalogCache("partition"),
    ).resolves.toBeUndefined();
  });
});
