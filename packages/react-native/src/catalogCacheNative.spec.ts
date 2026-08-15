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

describe("Release Catalog native cache compatibility", () => {
  beforeEach(() => {
    for (const key of Object.keys(nativeModule)) delete nativeModule[key];
  });

  it("keeps update checks cache-less on older native binaries", async () => {
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
