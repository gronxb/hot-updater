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
      targetVersion: "1.2.3",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: "*",
      platform: "ios",
      bundleVersion: 1,
    },
    {
      targetVersion: "1.2.x",
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
      targetVersion: "1.2",
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
  ];

  it("should return sources matching the current version exactly", () => {
    const result = filterTargetVersion("ios", "1.2.3", sources);
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
    const result = filterTargetVersion("ios", "1.2.4", sources);
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
    const result = filterTargetVersion("ios", "2.0.0", sources);
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleVersion: 1 },
    ]);
  });

  it("should handle invalid current version gracefully", () => {
    const result = filterTargetVersion("ios", "invalid.version", sources);
    expect(result).toEqual([]);
  });

  it("should return sources matching any version with wildcard", () => {
    const result = filterTargetVersion("ios", "1.3.0", sources);
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleVersion: 1 },
      { targetVersion: "^1.2.3", platform: "ios", bundleVersion: 1 },
    ]);
  });

  it("should sort the sources by version correctly", () => {
    const result = filterTargetVersion("ios", "1.2.4", sources);
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
});
