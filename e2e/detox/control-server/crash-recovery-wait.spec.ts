import { describe, expect, it } from "vitest";

import {
  createCrashRecoveryArtifactNames,
  getLaunchReportState,
  waitForCrashRecoveryState,
} from "./crash-recovery-wait.ts";
import type {
  CrashRecoveryDiagnostics,
  LaunchReportState,
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

  it("stops polling when the control client aborts the recovery wait", async () => {
    // Given: Android recovery has not reached the expected state yet.
    const abortController = new AbortController();
    const readCounts: string[] = [];
    const sleeps: number[] = [];

    // When: the client timeout aborts during the first poll sleep.
    const result = waitForCrashRecoveryState({
      androidLaunchSettleMs: 2000,
      attempts: 10,
      crashedBundleId: "crashed-1",
      createTimeoutError: () => new Error("timed out"),
      getLaunchReportState: (): LaunchReportState => ({
        fromBundleId: null,
        status: null,
        toBundleId: null,
      }),
      getMetadataState: (): MetadataState => ({
        stagingBundleId: null,
        verificationPending: null,
      }),
      isAndroidAppRunning: () => false,
      launchAndroidApp: () => {
        readCounts.push("launch");
      },
      platform: "android",
      pollIntervalMs: 1000,
      readDiagnostics: () => {
        readCounts.push("read");
        return pendingDiagnostics();
      },
      signal: abortController.signal,
      sleepMs: (_durationMs, signal) => {
        sleeps.push(_durationMs);
        expect(signal).toBe(abortController.signal);
        abortController.abort(new Error("client timed out"));
        throw new Error("Control job cancelled: client timed out");
      },
      stableBundleId: "stable-1",
    });

    // Then: no background poll continues into later scenarios.
    await expect(result).rejects.toThrow("client timed out");
    expect(readCounts).toEqual(["read", "launch"]);
    expect(sleeps).toEqual([2000]);
  });

  it("uses per-request diagnostic artifact names for recovery snapshots", () => {
    // Given: two bundle ids identify one recovery wait request.
    const names = createCrashRecoveryArtifactNames({
      crashedBundleId: "019e9cec/b803",
      stableBundleId: "019e9cec-03f9",
    });

    // When/Then: local diagnostic files cannot be overwritten by a later request.
    expect(names).toEqual({
      crashHistory:
        "crash-recovery-019e9cec-03f9-019e9cec-b803-crash-history.json",
      crashMarker:
        "crash-recovery-019e9cec-03f9-019e9cec-b803-crash-marker.json",
      launchReport:
        "crash-recovery-019e9cec-03f9-019e9cec-b803-launch-report.json",
      metadata: "crash-recovery-019e9cec-03f9-019e9cec-b803-metadata.json",
    });
    expect(names.metadata).not.toBe("recovery-metadata.json");
  });

  it("relaunches Android recovery even before the crash marker is readable", async () => {
    // Given: Android has crashed but run-as diagnostics do not expose the marker yet.
    const reads: string[] = [];
    const sleeps: number[] = [];
    const launches: string[] = [];

    // When: the first poll cannot read recovery files and the second poll recovers.
    await waitForCrashRecoveryState({
      androidLaunchSettleMs: 2000,
      attempts: 3,
      crashedBundleId: "crashed-1",
      createTimeoutError: () => new Error("timed out"),
      getLaunchReportState,
      getMetadataState: metadataState,
      isAndroidAppRunning: () => false,
      launchAndroidApp: () => {
        launches.push("launch");
      },
      platform: "android",
      pollIntervalMs: 1000,
      readDiagnostics: () => {
        reads.push("read");
        if (reads.length === 1) {
          return {
            ...pendingDiagnostics(),
            crashMarker: {
              exists: false,
              path: "marker",
              readError: null,
              value: null,
            },
          };
        }
        return recoveredDiagnostics();
      },
      sleepMs: (durationMs) => {
        sleeps.push(durationMs);
        return Promise.resolve();
      },
      stableBundleId: "stable-1",
    });

    // Then: recovery gets a relaunch chance without waiting for marker IO.
    expect(launches).toEqual(["launch"]);
    expect(sleeps).toEqual([2000]);
    expect(reads).toEqual(["read", "read"]);
  });

  it("cold launches recovery once when the crashed Android process is still alive", async () => {
    // Given: the JS crash disconnected Detox but left the crashed app PID alive.
    const reads: string[] = [];
    const sleeps: number[] = [];
    const launches: string[] = [];

    // When: the first cold launch starts recovery and that process completes later.
    await waitForCrashRecoveryState({
      androidLaunchSettleMs: 1000,
      attempts: 4,
      crashedBundleId: "crashed-1",
      createTimeoutError: () => new Error("timed out"),
      getLaunchReportState,
      getMetadataState: metadataState,
      isAndroidAppRunning: () => true,
      launchAndroidApp: () => {
        launches.push("launch");
      },
      platform: "android",
      pollIntervalMs: 250,
      readDiagnostics: () => {
        reads.push("read");
        if (reads.length < 3) {
          return pendingDiagnostics();
        }
        return recoveredDiagnostics();
      },
      sleepMs: (durationMs) => {
        sleeps.push(durationMs);
        return Promise.resolve();
      },
      stableBundleId: "stable-1",
    });

    // Then: the crashed process is replaced once, but the live recovery process is kept.
    expect(launches).toEqual(["launch"]);
    expect(sleeps).toEqual([1000, 250]);
    expect(reads).toEqual(["read", "read", "read"]);
  });

  it("does not relaunch Android after recovered metadata is persisted", async () => {
    // Given: metadata becomes visible one poll before the launch report.
    const reads: string[] = [];
    const sleeps: number[] = [];
    const launches: string[] = [];

    // When: the app exits after persisting recovered metadata.
    await waitForCrashRecoveryState({
      androidLaunchSettleMs: 1000,
      attempts: 4,
      crashedBundleId: "crashed-1",
      createTimeoutError: () => new Error("timed out"),
      getLaunchReportState,
      getMetadataState: metadataState,
      isAndroidAppRunning: () => false,
      launchAndroidApp: () => {
        launches.push("launch");
      },
      platform: "android",
      pollIntervalMs: 250,
      readDiagnostics: () => {
        reads.push("read");
        if (reads.length === 1) {
          return pendingDiagnostics();
        }
        const recovered = recoveredDiagnostics();
        return reads.length === 3
          ? recovered
          : { ...recovered, launchReport: pendingDiagnostics().launchReport };
      },
      sleepMs: (durationMs) => {
        sleeps.push(durationMs);
        return Promise.resolve();
      },
      stableBundleId: "stable-1",
    });

    // Then: a relaunch cannot erase the RECOVERED report between file reads.
    expect(launches).toEqual(["launch"]);
    expect(sleeps).toEqual([1000, 250]);
    expect(reads).toEqual(["read", "read", "read"]);
  });
});
