import { describe, expect, it } from "vitest";
import { type MatchSource, matchTargetVersion } from "./matchTargetVersion";

describe("matchTargetVersion", () => {
  it("should return the correct path when a matching version is found", () => {
    const matchSources = [
      {
        targetVersion: "1.2.3",
        latestBundleTimestamp: "1",
        path: "/path/to/version/1.2.3",
        platform: "ios",
      },
      {
        targetVersion: "1.2.x",
        latestBundleTimestamp: "2",
        path: "/path/to/version/1.2.x",
        platform: "ios",
      },
    ] as MatchSource[];
    const result = matchTargetVersion(matchSources, {
      version: "1.2.3",
      bundleTimestamp: "1",
      platform: "ios",
    });
    expect(result).toBe("/path/to/version/1.2.3");
  });

  it("should return undefined when no matching version is found", () => {
    const matchSources = [
      {
        targetVersion: "1.2.3",
        latestBundleTimestamp: "1",
        path: "/path/to/version/1.2.3",
        platform: "ios",
      },
      {
        targetVersion: "1.2.x",
        latestBundleTimestamp: "2",
        path: "/path/to/version/1.2.x",
        platform: "ios",
      },
    ] as MatchSource[];

    const result = matchTargetVersion(matchSources, {
      version: "2.0.0",
      bundleTimestamp: "2",
      platform: "ios",
    });
    expect(result).toBeUndefined();
  });

  it("should return the correct path when a wildcard version is found", () => {
    const matchSources = [
      {
        targetVersion: "*",
        latestBundleTimestamp: "2",
        path: "/path/to/version/wildcard",
        platform: "ios",
      },
      {
        targetVersion: "1.2.x",
        latestBundleTimestamp: "1",
        path: "/path/to/version/1.2.x",
        platform: "ios",
      },
    ] as MatchSource[];

    const result = matchTargetVersion(matchSources, {
      version: "1.3.0",
      bundleTimestamp: "1",
      platform: "ios",
    });
    expect(result).toBe("/path/to/version/wildcard");
  });
});
