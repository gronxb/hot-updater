import { describe, expect, it } from "vitest";
import { filterTargetVersion } from "./filterTargetVersion";

describe("filterTargetVersion", () => {
  const sources: any[] = [
    {
      targetVersion: "1.2.3",
      platform: "ios",
      bundleVersion: 2,
    },
    {
      targetVersion: "*",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: "1.2.3",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: "1.2.3 - 1.2.7",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: ">=1.2.3 <1.2.7",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: "~1.2.3",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: "^1.2.3",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: "^1.2.3",
      platform: "android",
      bundleVersion: 1,
    },
    {
      targetVersion: "1.2.x",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: "1.2",
      platform: "ios",
      bundleVersion: 1,
    },
  ];

  it("should return sources matching the current version exactly", () => {
    const result = filterTargetVersion(sources, "1.2.3", "ios");
    expect(result).toEqual([
      { targetVersion: "1.2.3", platform: "ios", bundleVersion: 2 },
      { targetVersion: "*", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2.3 - 1.2.7", platform: "ios", bundleVersion: 1 },
      { targetVersion: ">=1.2.3 <1.2.7", platform: "ios", bundleVersion: 1 },
      { targetVersion: "~1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "^1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2.x", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2", platform: "ios", bundleVersion: 1 },
    ]);
  });

  it("should return sources matching a range", () => {
    const result = filterTargetVersion(sources, "1.2.4", "ios");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2.3 - 1.2.7", platform: "ios", bundleVersion: 1 },
      {
        targetVersion: ">=1.2.3 <1.2.7",
        platform: "ios",
        bundleVersion: 1,
      },
      { targetVersion: "~1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "^1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2.x", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2", platform: "ios", bundleVersion: 1 },
    ]);
  });

  it("should return no sources if the current version does not match", () => {
    const result = filterTargetVersion(sources, "2.0.0", "ios");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleVersion: 1 },
    ]);
  });

  it("should handle invalid current version gracefully", () => {
    const result = filterTargetVersion(sources, "invalid.version", "ios");
    expect(result).toEqual([]);
  });

  it("should return sources matching any version with wildcard", () => {
    const result = filterTargetVersion(sources, "1.3.0", "ios");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleVersion: 1 },
      { targetVersion: "^1.2.3", platform: "ios", bundleVersion: 1 },
    ]);
  });

  it("should sort the sources by version correctly", () => {
    const result = filterTargetVersion(sources, "1.2.4", "ios");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2.3 - 1.2.7", platform: "ios", bundleVersion: 1 },
      { targetVersion: ">=1.2.3 <1.2.7", platform: "ios", bundleVersion: 1 },
      { targetVersion: "~1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "^1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2.x", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2", platform: "ios", bundleVersion: 1 },
    ]);
  });

  it("should sort the sources by version correctly", () => {
    const result = filterTargetVersion(sources, "1.2.4");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2.3 - 1.2.7", platform: "ios", bundleVersion: 1 },
      { targetVersion: ">=1.2.3 <1.2.7", platform: "ios", bundleVersion: 1 },
      { targetVersion: "~1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "^1.2.3", platform: "ios", bundleVersion: 1 },
      { targetVersion: "^1.2.3", platform: "android", bundleVersion: 1 },
      { targetVersion: "1.2.x", platform: "ios", bundleVersion: 1 },
      { targetVersion: "1.2", platform: "ios", bundleVersion: 1 },
    ]);
  });

  it("should return all sources if targetVersion is *", () => {
    const result = filterTargetVersion(sources, "*");
    expect(result).toEqual(sources);
  });
});
