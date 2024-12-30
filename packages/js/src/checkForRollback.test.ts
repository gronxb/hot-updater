import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";
import { checkForRollback } from "./checkForRollback";

const DEFAULT_BUNDLE = {
  fileUrl: "",
  fileHash: "",
  forceUpdate: false,
  platform: "ios",
  gitCommitHash: null,
  message: null,
  targetVersion: "1.0",
} as const;

describe("checkForRollback", () => {
  it("should return availableOldVersion if enabled is null or undefined", () => {
    const bundles: Bundle[] = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        enabled: true,
        ...DEFAULT_BUNDLE,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        enabled: false,
        ...DEFAULT_BUNDLE,
      },
      {
        id: "00000000-0000-0000-0000-000000000003",
        enabled: true,
        ...DEFAULT_BUNDLE,
      },
    ];
    const currentBundleId = "00000000-0000-0000-0000-000000000004";
    const result = checkForRollback(bundles, currentBundleId);
    expect(result).toBe(true);
  });

  it("should return undefined if no matching bundle is found", () => {
    const bundles: Bundle[] = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        enabled: true,
        ...DEFAULT_BUNDLE,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        enabled: false,
        ...DEFAULT_BUNDLE,
      },
    ];
    const currentBundleId = "00000000-0000-0000-0000-000000000003";
    const result = checkForRollback(bundles, currentBundleId);
    expect(result).toBe(true);
  });

  it("should return true if bundles are empty and update has already been done", () => {
    const result = checkForRollback([], "00000000-0000-0000-0000-000000000001");
    expect(result).toBe(true);
  });
});
