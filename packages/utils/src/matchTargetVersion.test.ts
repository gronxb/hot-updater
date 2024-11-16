import { describe, expect, it } from "vitest";
import { type MatchBundle, matchTargetVersion } from "./matchTargetVersion";

describe("matchTargetVersion", () => {
  it("should return the correct path when a matching version is found", () => {
    const matchBundles = [
      {
        targetVersion: "1.2.3",
        latestBundleId: "00000000-0000-0000-0000-000000000001",
        path: "/path/to/version/1.2.3",
        platform: "ios",
      },
      {
        targetVersion: "1.2.x",
        latestBundleId: "00000000-0000-0000-0000-000000000002",
        path: "/path/to/version/1.2.x",
        platform: "ios",
      },
    ] as MatchBundle[];
    const result = matchTargetVersion(matchBundles, {
      version: "1.2.3",
      bundleId: "00000000-0000-0000-0000-000000000001",
      platform: "ios",
    });
    expect(result).toBe("/path/to/version/1.2.3");
  });

  it("should return undefined when no matching version is found", () => {
    const matchBundles = [
      {
        targetVersion: "1.2.3",
        latestBundleId: "00000000-0000-0000-0000-000000000001",
        path: "/path/to/version/1.2.3",
        platform: "ios",
      },
      {
        targetVersion: "1.2.x",
        latestBundleId: "00000000-0000-0000-0000-000000000002",
        path: "/path/to/version/1.2.x",
        platform: "ios",
      },
    ] as MatchBundle[];

    const result = matchTargetVersion(matchBundles, {
      version: "2.0.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(result).toBeUndefined();
  });

  it("should return the correct path when a wildcard version is found", () => {
    const matchBundles = [
      {
        targetVersion: "*",
        latestBundleId: "00000000-0000-0000-0000-000000000002",
        path: "/path/to/version/wildcard",
        platform: "ios",
      },
      {
        targetVersion: "1.2.x",
        latestBundleId: "00000000-0000-0000-0000-000000000001",
        path: "/path/to/version/1.2.x",
        platform: "ios",
      },
    ] as MatchBundle[];

    const result = matchTargetVersion(matchBundles, {
      version: "1.3.0",
      bundleId: "00000000-0000-0000-0000-000000000001",
      platform: "ios",
    });
    expect(result).toBe("/path/to/version/wildcard");
  });
});
