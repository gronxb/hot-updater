import { describe, expect, it } from "vitest";

import {
  createCrashRecoveryArtifactNames,
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

describe("crash recovery wait", () => {
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
        crashedBundleId: null,
        status: null,
      }),
      getMetadataState: (): MetadataState => ({
        stagingBundleId: null,
        verificationPending: null,
      }),
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
      getLaunchReportState: (report): LaunchReportState => ({
        crashedBundleId:
          typeof report?.crashedBundleId === "string"
            ? report.crashedBundleId
            : null,
        status: typeof report?.status === "string" ? report.status : null,
      }),
      getMetadataState: (metadata): MetadataState => ({
        stagingBundleId:
          typeof metadata?.stagingBundleId === "string"
            ? metadata.stagingBundleId
            : null,
        verificationPending:
          typeof metadata?.verificationPending === "boolean"
            ? metadata.verificationPending
            : null,
      }),
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
        return {
          ...pendingDiagnostics(),
          launchReport: {
            exists: true,
            path: "report",
            readError: null,
            value: { crashedBundleId: "crashed-1", status: "RECOVERED" },
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
});
