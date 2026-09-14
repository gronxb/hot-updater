import { describe, expect, it, vi } from "vitest";

import {
  captureCommandWithDeadline,
  classifyArtifactSelection,
  classifyArtifactSelectionHistory,
  collectManifestDiffLogs,
} from "./manifest-diff-assertion.ts";

const archiveOnly = {
  changedAssetCount: 0,
  changedAssetFileCount: 0,
  changedAssetFilePaths: [],
  changedAssetPatchCount: 0,
  changedAssetPatchPaths: [],
  changedAssetsPresent: false,
  fileHashPresent: true,
  fileUrlPresent: true,
  manifestFileHashPresent: false,
  manifestUrlPresent: false,
  rawChangedAssetPaths: [],
};

const manifestDiff = {
  changedAssetCount: 2,
  changedAssetFileCount: 2,
  changedAssetFilePaths: ["main.bundle", "metadata.json"],
  changedAssetPatchCount: 1,
  changedAssetPatchPaths: ["main.bundle"],
  changedAssetsPresent: true,
  fileHashPresent: true,
  fileUrlPresent: true,
  manifestFileHashPresent: true,
  manifestUrlPresent: true,
  rawChangedAssetPaths: ["metadata.json"],
};

describe("manifest diff assertion", () => {
  it("skips reuse evidence only for a captured archive-only selection", () => {
    expect(classifyArtifactSelection(archiveOnly)).toBe("archive-only");
  });

  it("requires complete manifest-diff evidence before enabling strict reuse checks", () => {
    expect(classifyArtifactSelection(manifestDiff)).toBe("manifest-diff");
    for (const incomplete of [
      { ...manifestDiff, changedAssetCount: 0 },
      { ...manifestDiff, changedAssetsPresent: false },
      { ...manifestDiff, manifestFileHashPresent: false },
      { ...manifestDiff, manifestUrlPresent: false },
    ]) {
      expect(classifyArtifactSelection(incomplete)).toBeNull();
    }
  });

  it("requires every repeated capture to have one consistent complete selection", () => {
    expect(classifyArtifactSelectionHistory([archiveOnly, archiveOnly])).toBe(
      "archive-only",
    );
    expect(classifyArtifactSelectionHistory([manifestDiff, manifestDiff])).toBe(
      "manifest-diff",
    );
    expect(
      classifyArtifactSelectionHistory([archiveOnly, manifestDiff]),
    ).toBeNull();
    expect(
      classifyArtifactSelectionHistory([manifestDiff, archiveOnly]),
    ).toBeNull();
    expect(
      classifyArtifactSelectionHistory([
        manifestDiff,
        { ...manifestDiff, changedAssetPatchPaths: ["metadata.json"] },
      ]),
    ).toBeNull();
    expect(
      classifyArtifactSelectionHistory([
        archiveOnly,
        { ...archiveOnly, fileHashPresent: false },
      ]),
    ).toBeNull();
  });

  it("reuses one bounded iOS log snapshot for every manifest assertion check", async () => {
    const readIosLogs = vi.fn().mockResolvedValue("native events");
    const readAndroidArchiveLogs = vi.fn();
    const readAndroidBsdiffLogs = vi.fn();
    const readAndroidNativeLogs = vi.fn();

    await expect(
      collectManifestDiffLogs({
        platform: "ios",
        readAndroidArchiveLogs,
        readAndroidBsdiffLogs,
        readAndroidNativeLogs,
        readIosLogs,
      }),
    ).resolves.toEqual({
      archiveLogs: "native events",
      bsdiffLogs: "native events",
      nativeLogs: "native events",
    });
    expect(readIosLogs).toHaveBeenCalledOnce();
    expect(readAndroidArchiveLogs).not.toHaveBeenCalled();
    expect(readAndroidBsdiffLogs).not.toHaveBeenCalled();
    expect(readAndroidNativeLogs).not.toHaveBeenCalled();
  });

  it("terminates a stalled log command on its deadline or request abort", async () => {
    const stalledCommand = ["-e", "setInterval(() => {}, 1000)"];
    await expect(
      captureCommandWithDeadline(process.execPath, stalledCommand, {
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out after 50ms");

    const controller = new AbortController();
    const reason = new Error("request ended");
    const capture = captureCommandWithDeadline(
      process.execPath,
      stalledCommand,
      { signal: controller.signal, timeoutMs: 10_000 },
    );
    controller.abort(reason);
    await expect(capture).rejects.toBe(reason);
  });
});
