// @vitest-environment node

import type { ReleaseRow } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getReleaseActivity30d } from "./releaseActivity";

const createRelease = (id: string, bundleId: string | null): ReleaseRow =>
  ({ id, bundle_id: bundleId }) as ReleaseRow;

describe("getReleaseActivity30d", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requests one exact report for the distinct bundles on the page", async () => {
    const getReport = vi.fn().mockResolvedValue({
      state: "ready",
      data: {
        kind: "bundleSummaries",
        summary: [
          { bundleId: "bundle-a", installed: 2, recovered: 1 },
          { bundleId: "bundle-b", installed: 3, recovered: 0 },
        ],
      },
    });
    const result = await getReleaseActivity30d({ getReport }, [
      createRelease("release-a", "bundle-a"),
      createRelease("release-a-promoted", "bundle-a"),
      createRelease("release-b", "bundle-b"),
      createRelease("release-built-in", null),
    ]);

    expect(getReport).toHaveBeenCalledWith({
      query: {
        kind: "bundleSummaries",
        bundleIds: ["bundle-a", "bundle-b"],
        window: "30d",
      },
    });
    expect(result.get("bundle-a")).toEqual({
      bundleId: "bundle-a",
      installed: 2,
      recovered: 1,
    });
  });

  it("keeps the release list available while the report prepares", async () => {
    const getReport = vi.fn().mockResolvedValue({ state: "preparing" });
    const result = await getReleaseActivity30d({ getReport }, [
      createRelease("release-a", "bundle-a"),
    ]);
    expect(result.size).toBe(0);
  });

  it("keeps the release list available when Insights fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getReport = vi
      .fn()
      .mockRejectedValue(new Error("storage unavailable"));
    const result = await getReleaseActivity30d({ getReport }, [
      createRelease("release-a", "bundle-a"),
    ]);
    expect(result.size).toBe(0);
  });
});
