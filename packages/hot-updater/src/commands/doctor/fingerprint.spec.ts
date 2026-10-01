import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FingerprintResult,
  generateFingerprints,
  getFingerprintDiff,
} from "../../utils/fingerprint";
import { MissingFingerprintDependencyError } from "../../utils/fingerprint/dependency";
import { checkFingerprintJson } from "./fingerprint";

vi.mock("../../utils/fingerprint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/fingerprint")>()),
  ensureFingerprintConfig: vi.fn(async () => ({})),
  generateFingerprints: vi.fn(),
  getFingerprintDiff: vi.fn(),
}));

const fingerprint = (hash: string): FingerprintResult => ({
  hash,
  sources: [],
});

const source = (filePath: string) =>
  ({ type: "file", filePath, reasons: ["bareNativeDir"], hash: null }) as never;

describe("checkFingerprintJson", () => {
  beforeEach(() => {
    vi.mocked(generateFingerprints).mockResolvedValue({
      ios: fingerprint("ios-now"),
      android: fingerprint("android-now"),
    });
  });

  it("reports nothing when fingerprint.json matches the project", async () => {
    await expect(
      checkFingerprintJson({
        ios: fingerprint("ios-now"),
        android: fingerprint("android-now"),
      }),
    ).resolves.toEqual([]);
    expect(getFingerprintDiff).not.toHaveBeenCalled();
  });

  it("reports each platform whose fingerprint changed, with the sources that changed", async () => {
    vi.mocked(getFingerprintDiff).mockResolvedValue([
      {
        op: "changed",
        beforeSource: source("ios/App/AppDelegate.swift"),
        afterSource: source("ios/App/AppDelegate.swift"),
      },
      { op: "added", addedSource: source("ios/Modules/Camera.swift") },
    ]);

    const issues = await checkFingerprintJson({
      ios: fingerprint("ios-before"),
      android: fingerprint("android-now"),
    });

    expect(issues).toEqual([
      {
        type: "error",
        platform: "ios",
        code: "FINGERPRINT_JSON_STALE",
        message:
          "The iOS fingerprint changed since fingerprint.json was created.",
        resolution:
          "Run `npx hot-updater fingerprint create`, then rebuild the iOS app.",
        fixability: "command",
        commands: ["npx hot-updater fingerprint create"],
        paths: ["fingerprint.json"],
        changes: {
          added: ["ios/Modules/Camera.swift"],
          removed: [],
          changed: ["ios/App/AppDelegate.swift"],
        },
      },
    ]);
    expect(getFingerprintDiff).toHaveBeenCalledWith(
      fingerprint("ios-before"),
      expect.objectContaining({ platform: "ios" }),
    );
  });

  it("reports a platform fingerprint.json lacks", async () => {
    const issues = await checkFingerprintJson({
      ios: null,
      android: fingerprint("android-now"),
    });

    expect(issues).toMatchObject([
      {
        platform: "ios",
        code: "FINGERPRINT_JSON_STALE",
        message: "fingerprint.json has no iOS fingerprint.",
      },
    ]);
    expect(issues[0]).not.toHaveProperty("changes");
  });

  it("keeps the report when the changed sources cannot be listed", async () => {
    vi.mocked(getFingerprintDiff).mockRejectedValue(new Error("diff failed"));

    const issues = await checkFingerprintJson({
      ios: fingerprint("ios-now"),
      android: fingerprint("android-before"),
    });

    expect(issues).toMatchObject([
      { platform: "android", code: "FINGERPRINT_JSON_STALE" },
    ]);
    expect(issues[0]).not.toHaveProperty("changes");
  });

  it("reports a fingerprint it cannot compute, with the install command for a missing dependency", async () => {
    vi.mocked(generateFingerprints).mockRejectedValue(
      new MissingFingerprintDependencyError(),
    );

    const issues = await checkFingerprintJson({
      ios: fingerprint("ios-now"),
      android: fingerprint("android-now"),
    });

    expect(issues).toMatchObject([
      {
        type: "error",
        platform: "project",
        code: "FINGERPRINT_GENERATION_FAILED",
        fixability: "command",
        commands: [expect.stringContaining("@expo/fingerprint")],
      },
    ]);
  });
});
