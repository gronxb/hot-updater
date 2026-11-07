import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FingerprintResult,
  generateFingerprints,
  getFingerprintDiff,
} from "../../utils/fingerprint";
import {
  checkFingerprintJson,
  checkUnusedFingerprintJson,
} from "./fingerprint";

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

  it("blames a changed engine instead of listing sources when the engines differ", async () => {
    vi.mocked(getFingerprintDiff).mockClear();
    vi.mocked(generateFingerprints).mockResolvedValue({
      ios: { ...fingerprint("ios-now"), engine: "@expo/fingerprint@0.21.5" },
      android: {
        ...fingerprint("android-now"),
        engine: "@expo/fingerprint@0.21.5",
      },
    });

    const issues = await checkFingerprintJson({
      ios: {
        ...fingerprint("ios-before"),
        engine: "@expo/fingerprint@0.20.14",
      },
      android: {
        ...fingerprint("android-now"),
        engine: "@expo/fingerprint@0.21.5",
      },
    });

    expect(issues).toEqual([
      {
        type: "error",
        platform: "ios",
        code: "FINGERPRINT_ENGINE_CHANGED",
        message:
          "The iOS fingerprint changed because fingerprint.json was created with @expo/fingerprint@0.20.14 and the project now uses @expo/fingerprint@0.21.5. Native inputs may be unchanged.",
        resolution:
          "To keep updating iOS builds you already shipped, go back to @expo/fingerprint@0.20.14. If the fingerprint still differs with it, native inputs changed too, and builds you shipped need a rebuild. Otherwise run `npx hot-updater fingerprint create`, then rebuild the iOS app.",
        paths: ["fingerprint.json"],
      },
    ]);
    expect(getFingerprintDiff).not.toHaveBeenCalled();
  });

  it("warns when fingerprint.json doesn't record the engine behind a matching hash", async () => {
    vi.mocked(generateFingerprints).mockResolvedValue({
      ios: { ...fingerprint("ios-now"), engine: "@expo/fingerprint@0.21.5" },
      android: {
        ...fingerprint("android-now"),
        engine: "@expo/fingerprint@0.21.5",
      },
    });

    const issues = await checkFingerprintJson({
      ios: fingerprint("ios-now"),
      android: {
        ...fingerprint("android-now"),
        engine: "@expo/fingerprint@0.21.5",
      },
    });

    expect(issues).toEqual([
      {
        type: "warning",
        platform: "ios",
        code: "FINGERPRINT_ENGINE_UNRECORDED",
        message:
          "fingerprint.json doesn't record the engine behind the iOS fingerprint, which @expo/fingerprint@0.21.5 computes unchanged.",
        resolution:
          "Run `npx hot-updater fingerprint create` to record it, so doctor and deploy can tell an engine upgrade from a native change. The fingerprint stays the same.",
        commands: ["npx hot-updater fingerprint create"],
        paths: ["fingerprint.json"],
      },
    ]);
  });

  it("warns when another engine version computes the same hash", async () => {
    vi.mocked(generateFingerprints).mockResolvedValue({
      ios: { ...fingerprint("ios-now"), engine: "@expo/fingerprint@0.21.6" },
      android: {
        ...fingerprint("android-now"),
        engine: "@expo/fingerprint@0.21.6",
      },
    });

    const issues = await checkFingerprintJson({
      ios: { ...fingerprint("ios-now"), engine: "@expo/fingerprint@0.21.5" },
      android: {
        ...fingerprint("android-now"),
        engine: "@expo/fingerprint@0.21.6",
      },
    });

    expect(issues).toMatchObject([
      {
        type: "warning",
        platform: "ios",
        code: "FINGERPRINT_ENGINE_UNRECORDED",
        message:
          "fingerprint.json records @expo/fingerprint@0.21.5 for the iOS fingerprint, which @expo/fingerprint@0.21.6 now computes unchanged.",
      },
    ]);
  });

  it("lists changed sources when fingerprint.json predates recorded engines", async () => {
    vi.mocked(getFingerprintDiff).mockClear();
    vi.mocked(generateFingerprints).mockResolvedValue({
      ios: { ...fingerprint("ios-now"), engine: "@expo/fingerprint@0.21.5" },
      android: {
        ...fingerprint("android-now"),
        engine: "@expo/fingerprint@0.21.5",
      },
    });
    vi.mocked(getFingerprintDiff).mockResolvedValue([]);

    const issues = await checkFingerprintJson({
      ios: { ...fingerprint("ios-before"), sources: [source("ios/Podfile")] },
      android: {
        ...fingerprint("android-now"),
        engine: "@expo/fingerprint@0.21.5",
      },
    });

    expect(issues).toMatchObject([
      {
        platform: "ios",
        message:
          "The iOS fingerprint changed since fingerprint.json was created.",
      },
    ]);
    expect(getFingerprintDiff).toHaveBeenCalled();
  });
});

describe("checkUnusedFingerprintJson", () => {
  it("reports a fingerprint.json only a non-fingerprint strategy leaves", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hot-updater-unused-"));
    try {
      expect(checkUnusedFingerprintJson(cwd, "appVersion")).toEqual([]);

      await writeFile(path.join(cwd, "fingerprint.json"), "{}");
      expect(checkUnusedFingerprintJson(cwd, "fingerprint")).toEqual([]);
      expect(checkUnusedFingerprintJson(cwd, "appVersion")).toMatchObject([
        {
          platform: "project",
          code: "FINGERPRINT_JSON_UNUSED",
          paths: ["fingerprint.json"],
        },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
