import { describe, expect, it, vi } from "vitest";

import {
  createCrashRecoveryArtifactNames,
  getLaunchReportState,
  waitForCrashRecoveryState,
} from "./crash-recovery-wait.ts";
import type {
  CrashRecoveryDiagnostics,
  MetadataState,
} from "./crash-recovery-wait.ts";

function pendingDiagnostics(): CrashRecoveryDiagnostics {
  return {
    crashHistory: {
      exists: false,
      path: "history",
      readError: null,
      value: null,
    },
    crashMarker: { exists: true, path: "marker", readError: null, value: {} },
    launchReport: {
      exists: false,
      path: "report",
      readError: null,
      value: null,
    },
    metadata: { exists: false, path: "metadata", readError: null, value: null },
  };
}

function metadataState(
  metadata: Record<string, unknown> | null,
): MetadataState {
  return {
    stagingBundleId:
      typeof metadata?.stagingBundleId === "string"
        ? metadata.stagingBundleId
        : null,
    verificationPending:
      typeof metadata?.verificationPending === "boolean"
        ? metadata.verificationPending
        : null,
  };
}

function recoveredDiagnostics(): CrashRecoveryDiagnostics {
  return {
    ...pendingDiagnostics(),
    launchReport: {
      exists: true,
      path: "report",
      readError: null,
      value: {
        fromBundleId: "crashed-1",
        status: "RECOVERED",
        toBundleId: "stable-1",
      },
    },
    metadata: {
      exists: true,
      path: "metadata",
      readError: null,
      value: {
        stagingBundleId: "stable-1",
        verificationPending: false,
      },
    },
  };
}

function waitOptions(
  overrides: Partial<Parameters<typeof waitForCrashRecoveryState>[0]> = {},
) {
  return {
    attempts: 3,
    crashedBundleId: "crashed-1",
    createTimeoutError: () => new Error("recovery timed out"),
    getLaunchReportState,
    getMetadataState: metadataState,
    isAndroidRecoveryReady: vi.fn(() => true),
    platform: "android" as const,
    pollIntervalMs: 250,
    readDiagnostics: vi.fn(() => pendingDiagnostics()),
    sleepMs: vi.fn(async () => {}),
    stableBundleId: "stable-1",
    ...overrides,
  };
}

describe("crash recovery wait", () => {
  it("reads directional bundle ids from the native launch report", () => {
    expect(
      getLaunchReportState({
        fromBundleId: "crashed-1",
        status: "RECOVERED",
        toBundleId: "stable-1",
      }),
    ).toEqual({
      fromBundleId: "crashed-1",
      status: "RECOVERED",
      toBundleId: "stable-1",
    });
  });

  it("times out with native diagnostics when Android does not restart itself", async () => {
    const diagnostics = pendingDiagnostics();
    const createTimeoutError = vi.fn(() => new Error("recovery timed out"));
    const options = {
      ...waitOptions({
        createTimeoutError,
        readDiagnostics: vi.fn(() => diagnostics),
      }),
      // A launch dependency from an older caller must never repair the app under test.
      launchAndroidApp: vi.fn(() => {
        throw new Error("test harness relaunched app");
      }),
    };

    await expect(waitForCrashRecoveryState(options)).rejects.toThrow(
      "recovery timed out",
    );

    expect(options.launchAndroidApp).not.toHaveBeenCalled();
    expect(options.isAndroidRecoveryReady).not.toHaveBeenCalled();
    expect(options.sleepMs).toHaveBeenCalledTimes(3);
    expect(createTimeoutError).toHaveBeenCalledWith({
      attempts: 3,
      crashedBundleId: "crashed-1",
      stableBundleId: "stable-1",
      ...diagnostics,
    });
  });

  it("observes delayed native recovery before checking the automatically restarted process", async () => {
    const readDiagnostics = vi
      .fn()
      .mockReturnValueOnce(pendingDiagnostics())
      .mockReturnValue(recoveredDiagnostics());
    const isAndroidRecoveryReady = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const options = waitOptions({ readDiagnostics, isAndroidRecoveryReady });

    await expect(waitForCrashRecoveryState(options)).resolves.toEqual({});

    expect(readDiagnostics).toHaveBeenCalledTimes(3);
    expect(isAndroidRecoveryReady).toHaveBeenCalledTimes(2);
    expect(options.sleepMs).toHaveBeenCalledTimes(2);
    expect(options.sleepMs).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(options.sleepMs).toHaveBeenNthCalledWith(2, 250, undefined);
  });

  it("does not pass recovered files while the Android process is dead or not ready", async () => {
    const options = waitOptions({
      readDiagnostics: vi.fn(() => recoveredDiagnostics()),
      isAndroidRecoveryReady: vi.fn(() => false),
    });

    await expect(waitForCrashRecoveryState(options)).rejects.toThrow(
      "recovery timed out",
    );
    expect(options.isAndroidRecoveryReady).toHaveBeenCalledTimes(3);
  });

  it("waits for the directional report when metadata is visible first", async () => {
    const recovered = recoveredDiagnostics();
    const readDiagnostics = vi
      .fn()
      .mockReturnValueOnce({
        ...recovered,
        launchReport: pendingDiagnostics().launchReport,
      })
      .mockReturnValueOnce({
        ...recovered,
        launchReport: {
          ...recovered.launchReport,
          value: {
            ...recovered.launchReport.value,
            fromBundleId: "unrelated-crash",
          },
        },
      })
      .mockReturnValue(recovered);
    const options = waitOptions({ readDiagnostics });

    await expect(waitForCrashRecoveryState(options)).resolves.toEqual({});
    expect(options.isAndroidRecoveryReady).toHaveBeenCalledTimes(1);
    expect(options.sleepMs).toHaveBeenCalledTimes(2);
  });

  it("stops reading when the client aborts during a poll sleep", async () => {
    const abortController = new AbortController();
    const options = waitOptions({
      signal: abortController.signal,
      sleepMs: vi.fn(async (_durationMs, signal) => {
        expect(signal).toBe(abortController.signal);
        abortController.abort(new Error("client timed out"));
      }),
    });

    await expect(waitForCrashRecoveryState(options)).rejects.toThrow(
      "client timed out",
    );
    expect(options.readDiagnostics).toHaveBeenCalledTimes(1);
    expect(options.sleepMs).toHaveBeenCalledTimes(1);
  });

  it("does not consult Android process readiness for iOS recovery", async () => {
    const options = waitOptions({
      platform: "ios",
      readDiagnostics: vi.fn(() => recoveredDiagnostics()),
    });

    await expect(waitForCrashRecoveryState(options)).resolves.toEqual({});
    expect(options.isAndroidRecoveryReady).not.toHaveBeenCalled();
  });

  it("uses per-request diagnostic artifact names for recovery snapshots", () => {
    expect(
      createCrashRecoveryArtifactNames({
        crashedBundleId: "019e9cec/b803",
        stableBundleId: "019e9cec-03f9",
      }),
    ).toEqual({
      crashHistory:
        "crash-recovery-019e9cec-03f9-019e9cec-b803-crash-history.json",
      crashMarker:
        "crash-recovery-019e9cec-03f9-019e9cec-b803-crash-marker.json",
      launchReport:
        "crash-recovery-019e9cec-03f9-019e9cec-b803-launch-report.json",
      metadata: "crash-recovery-019e9cec-03f9-019e9cec-b803-metadata.json",
    });
  });
});
