// @vitest-environment node

import type { ReleaseRow } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getReleaseActivity30d } from "./releaseActivity";

const createRelease = (id: string, bundleId: string | null): ReleaseRow =>
  ({ id, bundle_id: bundleId }) as ReleaseRow;

describe("getReleaseActivity30d", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requests one 30-day summary for the distinct Bundles on the page", async () => {
    const getBundleEventSummaries = vi.fn().mockResolvedValue([
      { bundleId: "bundle-a", installed: 2, recovered: 1 },
      { bundleId: "bundle-b", installed: 3, recovered: 0 },
    ]);

    const result = await getReleaseActivity30d({ getBundleEventSummaries }, [
      createRelease("release-a", "bundle-a"),
      createRelease("release-a-promoted", "bundle-a"),
      createRelease("release-b", "bundle-b"),
      createRelease("release-built-in", null),
    ]);

    expect(getBundleEventSummaries).toHaveBeenCalledOnce();
    expect(getBundleEventSummaries).toHaveBeenCalledWith(
      ["bundle-a", "bundle-b"],
      "30d",
    );
    expect(result.get("bundle-a")).toEqual({
      bundleId: "bundle-a",
      installed: 2,
      recovered: 1,
    });
  });

  it("keeps the Release list available when Insights cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getBundleEventSummaries = vi
      .fn()
      .mockRejectedValue(new Error("scan limit exceeded"));

    const result = await getReleaseActivity30d({ getBundleEventSummaries }, [
      createRelease("release-a", "bundle-a"),
    ]);

    expect(result.size).toBe(0);
  });
});
