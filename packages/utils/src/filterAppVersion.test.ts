import { describe, expect, it } from "vitest";
import { filterAppVersion } from "./filterAppVersion";
import type { Bundle } from "./types";

const DEFAULT_BUNDLE = {
  fileUrl: "",
  fileHash: "",
  gitCommitHash: null,
  message: null,
  enabled: true,
  forceUpdate: false,
} as const;

describe("filterAppVersion", () => {
  const bundles: Bundle[] = [
    {
      ...DEFAULT_BUNDLE,
      platform: "ios",
      targetVersion: "1.2.3",
      id: "00000000-0000-0000-0000-000000000002",
    },
    {
      ...DEFAULT_BUNDLE,
      platform: "ios",
      targetVersion: "*",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      ...DEFAULT_BUNDLE,
      platform: "ios",
      targetVersion: "1.2.3",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      ...DEFAULT_BUNDLE,
      platform: "ios",
      targetVersion: "1.2.3 - 1.2.7",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      ...DEFAULT_BUNDLE,
      platform: "ios",
      targetVersion: ">=1.2.3 <1.2.7",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      ...DEFAULT_BUNDLE,
      platform: "ios",
      targetVersion: "~1.2.3",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      ...DEFAULT_BUNDLE,
      platform: "ios",
      targetVersion: "^1.2.3",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      ...DEFAULT_BUNDLE,
      targetVersion: "^1.2.3",
      platform: "android",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      ...DEFAULT_BUNDLE,
      targetVersion: "1.2.x",
      platform: "ios",
      id: "00000000-0000-0000-0000-000000000001",
    },
    {
      ...DEFAULT_BUNDLE,
      targetVersion: "1.2",
      platform: "ios",
      id: "00000000-0000-0000-0000-000000000001",
    },
  ];

  it("should return bundles matching the current version exactly", () => {
    const result = filterAppVersion(
      bundles.filter((b) => b.platform === "ios"),
      "1.2.3",
    );
    expect(result).toEqual([
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "*",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.3 - 1.2.7",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: ">=1.2.3 <1.2.7",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "~1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "^1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.x",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
    ]);
  });

  it("should return bundles matching a range", () => {
    const result = filterAppVersion(
      bundles.filter((b) => b.platform === "ios"),
      "1.2.4",
    );
    expect(result).toEqual([
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "*",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.3 - 1.2.7",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: ">=1.2.3 <1.2.7",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "~1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "^1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.x",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
    ]);
  });

  it("should return no bundles if the current version does not match", () => {
    const result = filterAppVersion(
      bundles.filter((b) => b.platform === "ios"),
      "2.0.0",
    );
    expect(result).toEqual([
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "*",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
    ]);
  });

  it("should handle invalid current version gracefully", () => {
    const result = filterAppVersion(
      bundles.filter((b) => b.platform === "ios"),
      "invalid.version",
    );
    expect(result).toEqual([]);
  });

  it("should return bundles matching any version with wildcard", () => {
    const result = filterAppVersion(
      bundles.filter((b) => b.platform === "ios"),
      "1.3.0",
    );
    expect(result).toEqual([
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "*",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "^1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
    ]);
  });

  it("should sort the bundles by version correctly", () => {
    const result = filterAppVersion(
      bundles.filter((b) => b.platform === "ios"),
      "1.2.4",
    );
    expect(result).toEqual([
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "*",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.3 - 1.2.7",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: ">=1.2.3 <1.2.7",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "~1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "^1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.x",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
    ]);
  });

  it("should sort the bundles by version correctly", () => {
    const result = filterAppVersion(bundles, "1.2.4");
    expect(result).toEqual([
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "*",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.3 - 1.2.7",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: ">=1.2.3 <1.2.7",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "~1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "^1.2.3",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "^1.2.3",
        platform: "android",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2.x",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
      {
        ...DEFAULT_BUNDLE,
        targetVersion: "1.2",
        platform: "ios",
        id: "00000000-0000-0000-0000-000000000001",
      },
    ]);
  });

  it("should return all bundles if targetVersion is *", () => {
    const result = filterAppVersion(bundles, "*");
    expect(result).toEqual(bundles);
  });

  it("should prioritize platform bundles", () => {
    const result = filterAppVersion(
      [
        {
          ...DEFAULT_BUNDLE,
          platform: "android",
          fileUrl: "/build.zip",
          fileHash:
            "d0cc1d97b7a50645db1ad0e502c63ac52c1afe799550949a62c04fe0ae99a606",
          message: "",
          targetVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000001",
          enabled: true,
        },
        {
          ...DEFAULT_BUNDLE,
          platform: "ios",
          fileUrl: "/build.zip",
          fileHash:
            "516490c4a042d487cda558986a9a162b75625f242cb2291ba3b915fae9a1b264",
          message: "",
          targetVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000002",
          enabled: true,
        },
        {
          ...DEFAULT_BUNDLE,
          platform: "android",
          fileUrl: "/build.zip",
          fileHash:
            "f519fc7d303eede4c3c549622a5640a88700a3e58daf5df44b0b748971c77bb3",
          message: "",
          targetVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000003",
          enabled: true,
        },
        {
          ...DEFAULT_BUNDLE,
          platform: "ios",
          fileUrl: "/build.zip",
          fileHash:
            "eea69b75925f9f9e266cf3ffce87effd1f00b9a09832d690ca145d64c92714e1",
          message: "",
          targetVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000004",
          enabled: true,
        },
      ].filter((b) => b.platform === "ios") as Bundle[],
      "1.0",
    );
    expect(result).toEqual([
      {
        ...DEFAULT_BUNDLE,
        platform: "ios",
        fileUrl: "/build.zip",
        fileHash:
          "eea69b75925f9f9e266cf3ffce87effd1f00b9a09832d690ca145d64c92714e1",
        message: "",
        targetVersion: "1.0",
        id: "00000000-0000-0000-0000-000000000004",
        enabled: true,
      },
      {
        ...DEFAULT_BUNDLE,
        platform: "ios",
        fileUrl: "/build.zip",
        fileHash:
          "516490c4a042d487cda558986a9a162b75625f242cb2291ba3b915fae9a1b264",
        message: "",
        targetVersion: "1.0",
        id: "00000000-0000-0000-0000-000000000002",
        enabled: true,
      },
    ]);
  });

  it("should prioritize platform bundles", () => {
    const result = filterAppVersion(
      [
        {
          ...DEFAULT_BUNDLE,
          platform: "android",
          fileUrl: "/build.zip",
          fileHash:
            "d0cc1d97b7a50645db1ad0e502c63ac52c1afe799550949a62c04fe0ae99a606",
          message: "",
          targetVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000001",
          enabled: true,
        },
        {
          ...DEFAULT_BUNDLE,
          platform: "ios",
          fileUrl: "/build.zip",
          fileHash:
            "516490c4a042d487cda558986a9a162b75625f242cb2291ba3b915fae9a1b264",
          message: "",
          targetVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000002",
          enabled: true,
        },
        {
          ...DEFAULT_BUNDLE,
          platform: "android",
          fileUrl: "/build.zip",
          fileHash:
            "f519fc7d303eede4c3c549622a5640a88700a3e58daf5df44b0b748971c77bb3",
          message: "",
          targetVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000003",
          enabled: true,
        },
        {
          ...DEFAULT_BUNDLE,
          platform: "ios",
          fileUrl: "/build.zip",
          fileHash:
            "eea69b75925f9f9e266cf3ffce87effd1f00b9a09832d690ca145d64c92714e1",
          message: "",
          targetVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000004",
          enabled: true,
        },
      ].filter((b) => b.platform === "ios") as Bundle[],
      "1.x",
    );
    expect(result).toEqual([
      {
        ...DEFAULT_BUNDLE,
        platform: "ios",
        fileUrl: "/build.zip",
        fileHash:
          "eea69b75925f9f9e266cf3ffce87effd1f00b9a09832d690ca145d64c92714e1",
        message: "",
        targetVersion: "1.0",
        id: "00000000-0000-0000-0000-000000000004",
        enabled: true,
      },
      {
        ...DEFAULT_BUNDLE,
        platform: "ios",
        fileUrl: "/build.zip",
        fileHash:
          "516490c4a042d487cda558986a9a162b75625f242cb2291ba3b915fae9a1b264",
        message: "",
        targetVersion: "1.0",
        id: "00000000-0000-0000-0000-000000000002",
        enabled: true,
      },
    ]);
  });
});
