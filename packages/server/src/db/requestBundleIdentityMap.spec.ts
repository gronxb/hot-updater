import type { Bundle } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { createRequestBundleIdentityMap } from "./requestBundleIdentityMap";

const baseBundle: Bundle = {
  channel: "production",
  enabled: true,
  fileHash: "file-hash",
  fingerprintHash: null,
  gitCommitHash: null,
  id: "00000000-0000-0000-0000-000000000001",
  message: "bundle",
  platform: "ios",
  shouldForceUpdate: false,
  storageUri: "s3://bucket/bundle.zip",
  targetAppVersion: "1.0.0",
};

describe("createRequestBundleIdentityMap", () => {
  it("returns seeded bundles without loading them again", async () => {
    const loadBundleById = vi.fn(async () => null);
    const identityMap = createRequestBundleIdentityMap({
      loadBundleById,
      seeds: [baseBundle],
    });

    await expect(identityMap.get(baseBundle.id)).resolves.toBe(baseBundle);
    expect(loadBundleById).not.toHaveBeenCalled();
  });

  it("shares one fallback lookup for repeated bundle reads", async () => {
    const loadedBundle: Bundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000002",
      message: "loaded",
    };
    const loadBundleById = vi.fn(async () => loadedBundle);
    const identityMap = createRequestBundleIdentityMap({
      loadBundleById,
      seeds: [],
    });

    const [first, second] = await Promise.all([
      identityMap.get(loadedBundle.id),
      identityMap.get(loadedBundle.id),
    ]);
    const third = await identityMap.get(loadedBundle.id);

    expect(first).toBe(loadedBundle);
    expect(second).toBe(loadedBundle);
    expect(third).toBe(loadedBundle);
    expect(loadBundleById).toHaveBeenCalledTimes(1);
    expect(loadBundleById).toHaveBeenCalledWith(loadedBundle.id, undefined);
  });
});
