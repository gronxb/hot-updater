import { describe, expect, it, vi } from "vitest";

import {
  captureCommandWithDeadline,
  classifyArtifactSelection,
  collectManifestDiffLogs,
} from "./manifest-diff-assertion.ts";

const archiveOnly = {
  changedAssetCount: 0,
  changedAssetsPresent: false,
  fileHashPresent: true,
  fileUrlPresent: true,
  manifestFileHashPresent: false,
  manifestUrlPresent: false,
};

const manifestDiff = {
  changedAssetCount: 2,
  changedAssetsPresent: true,
  fileHashPresent: true,
  fileUrlPresent: true,
  manifestFileHashPresent: true,
  manifestUrlPresent: true,
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
