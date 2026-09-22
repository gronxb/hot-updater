import { describe, expect, it, vi } from "vitest";

import { createStandaloneBundleReader } from "./standaloneBundleReader";
import type { StandaloneBundleRemote } from "./standaloneBundleRemote";

describe("standalone bounded reads", () => {
  it("hydrates only the requested patch owners without listing bundle history", async () => {
    const remote = {
      loadBundles: vi.fn(async () => {
        throw new Error("full bundle history scan");
      }),
      loadBundle: vi.fn(async () => null),
    };
    const reader = createStandaloneBundleReader(
      remote as unknown as StandaloneBundleRemote,
    );
    await expect(
      reader.findMany({
        model: "bundle_patches",
        where: [{ field: "bundle_id", operator: "in", value: ["missing"] }],
        limit: 100,
        offset: 0,
        orderBy: [{ field: "id", direction: "asc" }],
      }),
    ).resolves.toEqual([]);
    expect(remote.loadBundle).toHaveBeenCalledExactlyOnceWith("missing");
    expect(remote.loadBundles).not.toHaveBeenCalled();
  });

  it("does not scan history when the remote cannot execute a requested filter", async () => {
    const remote = {
      loadBundleWindow: vi.fn(async () => null),
      loadBundleRows: vi.fn(async () => []),
    };
    const reader = createStandaloneBundleReader(
      remote as unknown as StandaloneBundleRemote,
    );
    await expect(
      reader.findMany({
        model: "bundles",
        where: [{ field: "file_hash", value: "hash" }],
        limit: 1,
        offset: 0,
      }),
    ).rejects.toThrow();
    expect(remote.loadBundleRows).not.toHaveBeenCalled();
  });
});
