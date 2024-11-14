import { describe, expect, it } from "vitest";
import { filterTargetVersion } from "./filterTargetVersion";

describe("filterTargetVersion", () => {
  const bundles: any[] = [
    {
      targetVersion: "1.2.3",
      platform: "ios",
      bundleId: "2",
    },
    {
      targetVersion: "*",
      platform: "ios",
      bundleId: "1",
    },
    {
      targetVersion: "1.2.3",
      platform: "ios",
      bundleId: "1",
    },
    {
      targetVersion: "1.2.3 - 1.2.7",
      platform: "ios",
      bundleId: "1",
    },
    {
      targetVersion: ">=1.2.3 <1.2.7",
      platform: "ios",
      bundleId: "1",
    },
    {
      targetVersion: "~1.2.3",
      platform: "ios",
      bundleId: "1",
    },
    {
      targetVersion: "^1.2.3",
      platform: "ios",
      bundleId: "1",
    },
    {
      targetVersion: "^1.2.3",
      platform: "android",
      bundleId: "1",
    },
    {
      targetVersion: "1.2.x",
      platform: "ios",
      bundleId: "1",
    },
    {
      targetVersion: "1.2",
      platform: "ios",
      bundleId: "1",
    },
  ];

  it("should return bundles matching the current version exactly", () => {
    const result = filterTargetVersion(bundles, "1.2.3", "ios");
    expect(result).toEqual([
      { targetVersion: "1.2.3", platform: "ios", bundleId: "2" },
      { targetVersion: "*", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2.3 - 1.2.7", platform: "ios", bundleId: "1" },
      { targetVersion: ">=1.2.3 <1.2.7", platform: "ios", bundleId: "1" },
      { targetVersion: "~1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "^1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2.x", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2", platform: "ios", bundleId: "1" },
    ]);
  });

  it("should return bundles matching a range", () => {
    const result = filterTargetVersion(bundles, "1.2.4", "ios");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2.3 - 1.2.7", platform: "ios", bundleId: "1" },
      {
        targetVersion: ">=1.2.3 <1.2.7",
        platform: "ios",
        bundleId: "1",
      },
      { targetVersion: "~1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "^1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2.x", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2", platform: "ios", bundleId: "1" },
    ]);
  });

  it("should return no bundles if the current version does not match", () => {
    const result = filterTargetVersion(bundles, "2.0.0", "ios");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleId: "1" },
    ]);
  });

  it("should handle invalid current version gracefully", () => {
    const result = filterTargetVersion(bundles, "invalid.version", "ios");
    expect(result).toEqual([]);
  });

  it("should return bundles matching any version with wildcard", () => {
    const result = filterTargetVersion(bundles, "1.3.0", "ios");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleId: "1" },
      { targetVersion: "^1.2.3", platform: "ios", bundleId: "1" },
    ]);
  });

  it("should sort the bundles by version correctly", () => {
    const result = filterTargetVersion(bundles, "1.2.4", "ios");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2.3 - 1.2.7", platform: "ios", bundleId: "1" },
      { targetVersion: ">=1.2.3 <1.2.7", platform: "ios", bundleId: "1" },
      { targetVersion: "~1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "^1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2.x", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2", platform: "ios", bundleId: "1" },
    ]);
  });

  it("should sort the bundles by version correctly", () => {
    const result = filterTargetVersion(bundles, "1.2.4");
    expect(result).toEqual([
      { targetVersion: "*", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2.3 - 1.2.7", platform: "ios", bundleId: "1" },
      { targetVersion: ">=1.2.3 <1.2.7", platform: "ios", bundleId: "1" },
      { targetVersion: "~1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "^1.2.3", platform: "ios", bundleId: "1" },
      { targetVersion: "^1.2.3", platform: "android", bundleId: "1" },
      { targetVersion: "1.2.x", platform: "ios", bundleId: "1" },
      { targetVersion: "1.2", platform: "ios", bundleId: 1 },
    ]);
  });

  it("should return all bundles if targetVersion is *", () => {
    const result = filterTargetVersion(bundles, "*");
    expect(result).toEqual(bundles);
  });

  it("should prioritize platform bundles", () => {
    const result = filterTargetVersion(
      [
        {
          forceUpdate: false,
          platform: "android",
          file: "/android/build.zip",
          hash: "d0cc1d97b7a50645db1ad0e502c63ac52c1afe799550949a62c04fe0ae99a606",
          description: "",
          targetVersion: "1.0",
          bundleId: "20240724000141",
          enabled: true,
        },
        {
          forceUpdate: false,
          platform: "ios",
          file: "/ios/build.zip",
          hash: "516490c4a042d487cda558986a9a162b75625f242cb2291ba3b915fae9a1b264",
          description: "",
          targetVersion: "1.0",
          bundleId: "20240724000127",
          enabled: true,
        },
        {
          forceUpdate: false,
          platform: "android",
          file: "/android/build.zip",
          hash: "f519fc7d303eede4c3c549622a5640a88700a3e58daf5df44b0b748971c77bb3",
          description: "",
          targetVersion: "1.0",
          bundleId: "20240724000059",
          enabled: true,
        },
        {
          forceUpdate: false,
          platform: "ios",
          file: "/ios/build.zip",
          hash: "eea69b75925f9f9e266cf3ffce87effd1f00b9a09832d690ca145d64c92714e1",
          description: "",
          targetVersion: "1.0",
          bundleId: "20240724000047",
          enabled: true,
        },
      ],
      "1.0",
      "ios",
    );
    expect(result).toEqual([
      {
        forceUpdate: false,
        platform: "ios",
        file: "/ios/build.zip",
        hash: "516490c4a042d487cda558986a9a162b75625f242cb2291ba3b915fae9a1b264",
        description: "",
        targetVersion: "1.0",
        bundleId: "20240724000127",
        enabled: true,
      },
      {
        forceUpdate: false,
        platform: "ios",
        file: "/ios/build.zip",
        hash: "eea69b75925f9f9e266cf3ffce87effd1f00b9a09832d690ca145d64c92714e1",
        description: "",
        targetVersion: "1.0",
        bundleId: "20240724000047",
        enabled: true,
      },
    ]);
  });

  it("should prioritize platform bundles", () => {
    const result = filterTargetVersion(
      [
        {
          forceUpdate: false,
          platform: "android",
          file: "/android/build.zip",
          hash: "d0cc1d97b7a50645db1ad0e502c63ac52c1afe799550949a62c04fe0ae99a606",
          description: "",
          targetVersion: "1.0",
          bundleId: "20240724000141",
          enabled: true,
        },
        {
          forceUpdate: false,
          platform: "ios",
          file: "/ios/build.zip",
          hash: "516490c4a042d487cda558986a9a162b75625f242cb2291ba3b915fae9a1b264",
          description: "",
          targetVersion: "1.0",
          bundleId: "20240724000127",
          enabled: true,
        },
        {
          forceUpdate: false,
          platform: "android",
          file: "/android/build.zip",
          hash: "f519fc7d303eede4c3c549622a5640a88700a3e58daf5df44b0b748971c77bb3",
          description: "",
          targetVersion: "1.0",
          bundleId: "20240724000059",
          enabled: true,
        },
        {
          forceUpdate: false,
          platform: "ios",
          file: "/ios/build.zip",
          hash: "eea69b75925f9f9e266cf3ffce87effd1f00b9a09832d690ca145d64c92714e1",
          description: "",
          targetVersion: "1.0",
          bundleId: "20240724000047",
          enabled: true,
        },
      ],
      "1.x",
      "ios",
    );
    expect(result).toEqual([
      {
        forceUpdate: false,
        platform: "ios",
        file: "/ios/build.zip",
        hash: "516490c4a042d487cda558986a9a162b75625f242cb2291ba3b915fae9a1b264",
        description: "",
        targetVersion: "1.0",
        bundleId: "20240724000127",
        enabled: true,
      },
      {
        forceUpdate: false,
        platform: "ios",
        file: "/ios/build.zip",
        hash: "eea69b75925f9f9e266cf3ffce87effd1f00b9a09832d690ca145d64c92714e1",
        description: "",
        targetVersion: "1.0",
        bundleId: "20240724000047",
        enabled: true,
      },
    ]);
  });
});
