import { describe, expect, it } from "vitest";

import {
  advanceAndroidRestartWait,
  hasNativeRestartEvidenceAfterMarker,
} from "./android-restart-wait.ts";

describe("Android automatic restart wait", () => {
  it("rejects stale restart logs from an earlier launch", () => {
    const logs = [
      "I/HotUpdaterImpl: Started restart trampoline to apply update bundle",
      "I/HotUpdaterE2E: current-launch-marker",
    ].join("\n");

    expect(
      hasNativeRestartEvidenceAfterMarker(logs, "current-launch-marker"),
    ).toBe(false);
  });

  it("completes only after current native evidence, target staging, and stable instrumentation teardown", () => {
    const currentLogs = [
      "I/HotUpdaterE2E: current-launch-marker",
      "I/HotUpdaterImpl: Started restart trampoline to apply update bundle",
    ].join("\n");
    let state = { clearedObservations: 0 };

    state = advanceAndroidRestartWait(state, {
      hasNativeRestartEvidence: true,
      hasTargetStaging: true,
      instrumentationActive: false,
    });
    expect(state).toEqual({ clearedObservations: 1 });

    state = advanceAndroidRestartWait(state, {
      hasNativeRestartEvidence: true,
      hasTargetStaging: true,
      instrumentationActive: true,
    });
    expect(state).toEqual({ clearedObservations: 0 });

    for (let observation = 1; observation <= 3; observation += 1) {
      state = advanceAndroidRestartWait(state, {
        hasNativeRestartEvidence: hasNativeRestartEvidenceAfterMarker(
          currentLogs,
          "current-launch-marker",
        ),
        hasTargetStaging: true,
        instrumentationActive: false,
      });
      expect(state.clearedObservations).toBe(observation);
    }
  });

  it("does not count instrumentation teardown before target staging exists", () => {
    const state = advanceAndroidRestartWait(
      { clearedObservations: 2 },
      {
        hasNativeRestartEvidence: true,
        hasTargetStaging: false,
        instrumentationActive: false,
      },
    );

    expect(state).toEqual({ clearedObservations: 0 });
  });
});
