import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";
import { checkForRollback } from "./checkForRollback";

const DEFAULT_BUNDLE_FINGERPRINT_STRATEGY = {
  fileHash: "",
  shouldForceUpdate: false,
  platform: "ios",
  gitCommitHash: null,
  message: null,
  targetAppVersion: "1.0",
  channel: "production",
  storageUri:
    "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
  fingerprintHash: null,
} as const;

describe("checkForRollback", () => {
  it("should return availableOldVersion if enabled is null or undefined", () => {
    const bundles: Bundle[] = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        enabled: true,
        ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        enabled: false,
        ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
        storageUri:
          "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
      },
      {
        id: "00000000-0000-0000-0000-000000000003",
        enabled: true,
        ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
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
        ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        enabled: false,
        ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
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
