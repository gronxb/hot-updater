import { describe, expect, it } from "vitest";

import {
  advanceAndroidRestartWait,
  hasNativeRestartEvidenceAfterMarker,
  isAndroidRecoveryProcessReady,
} from "./android-restart-wait.ts";

describe("Android automatic restart wait", () => {
  it.each([
    {},
    { processId: "" },
    { focusedPackage: "launcher" },
    { hasNativeRestartEvidence: false },
  ])("requires a live foreground app after native restart: %j", (overrides) => {
    expect(
      isAndroidRecoveryProcessReady({
        appId: "app.example",
        focusedPackage: "app.example",
        hasNativeRestartEvidence: true,
        processId: "1234",
        ...overrides,
      }),
    ).toBe(Object.keys(overrides).length === 0);
  });

  it("accepts a native watchdog restart only after the current launch marker", () => {
    const message = "Recovery watchdog detected crash marker, relaunching app";
    expect(
      hasNativeRestartEvidenceAfterMarker(
        `${message}\ncurrent-launch-marker`,
        "current-launch-marker",
      ),
    ).toBe(false);
    expect(
      hasNativeRestartEvidenceAfterMarker(
        `current-launch-marker\n${message}`,
        "current-launch-marker",
      ),
    ).toBe(true);
  });

  it("rejects stale restart logs from an earlier launch", () => {
    const logs = [
      "I/HotUpdaterImpl: Started restart trampoline to apply update bundle",
      "I/HotUpdaterE2E: current-launch-marker",
    ].join("\n");

    expect(
      hasNativeRestartEvidenceAfterMarker(logs, "current-launch-marker"),
    ).toBe(false);
  });

  it("completes only after current native evidence, target staging, and a stable live foreground process", () => {
    const currentLogs = [
      "I/HotUpdaterE2E: current-launch-marker",
      "I/HotUpdaterImpl: Started restart trampoline to apply update bundle",
    ].join("\n");
    let state = { clearedObservations: 0 };

    state = advanceAndroidRestartWait(state, {
      hasNativeRestartEvidence: true,
      hasTargetStaging: true,
      processReady: true,
    });
    expect(state).toEqual({ clearedObservations: 1 });

    state = advanceAndroidRestartWait(state, {
      hasNativeRestartEvidence: true,
      hasTargetStaging: true,
      processReady: false,
    });
    expect(state).toEqual({ clearedObservations: 0 });

    for (let observation = 1; observation <= 3; observation += 1) {
      state = advanceAndroidRestartWait(state, {
        hasNativeRestartEvidence: hasNativeRestartEvidenceAfterMarker(
          currentLogs,
          "current-launch-marker",
        ),
        hasTargetStaging: true,
        processReady: true,
      });
      expect(state.clearedObservations).toBe(observation);
    }
  });

  it("does not count the process before target staging exists", () => {
    const state = advanceAndroidRestartWait(
      { clearedObservations: 2 },
      {
        hasNativeRestartEvidence: true,
        hasTargetStaging: false,
        processReady: true,
      },
    );

    expect(state).toEqual({ clearedObservations: 0 });
  });
});
