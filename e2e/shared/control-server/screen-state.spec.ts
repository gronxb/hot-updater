import { describe, expect, it } from "vitest";

import {
  beginE2eScreenStateLaunch,
  handlePatchE2eScreenState,
  prepareE2eStartupCheck,
  readE2eScreenStateSnapshot,
  resetE2eScreenState,
  setE2eScreenStateLaunchGeneration,
} from "./screen-state.ts";

describe("E2E screen state control boundary", () => {
  it("patches and resets remount-safe screen state", () => {
    resetE2eScreenState();

    handlePatchE2eScreenState({
      cohortActionResult: "set -> qa",
      cohortInput: "qa",
      runtimeChannelInput: "beta-next",
    });

    handlePatchE2eScreenState({
      crashHistoryCount: "2",
      currentBundleId: "bundle-running",
      currentCohort: "qa",
      currentReleaseId: "release-running",
      detailPageMarker: "detail-b",
      detailPageTitle: "Second Page",
      diagnosticReceipt: '{"verified":true}',
      generationEvents: '{"latestSequence":12}',
      stagingBundleId: "bundle-1",
      stagingReleaseId: "release-1",
      verificationPending: true,
    });

    expect(readE2eScreenStateSnapshot()).toMatchObject({
      cohortActionResult: "set -> qa",
      cohortInput: "qa",
      crashHistoryCount: "2",
      currentBundleId: "bundle-running",
      currentCohort: "qa",
      currentReleaseId: "release-running",
      detailPageMarker: "detail-b",
      detailPageTitle: "Second Page",
      diagnosticReceipt: '{"verified":true}',
      generationEvents: '{"latestSequence":12}',
      runtimeChannelInput: "beta-next",
      stagingBundleId: "bundle-1",
      stagingReleaseId: "release-1",
      verificationPending: true,
    });

    expect(resetE2eScreenState()).toEqual({
      screenState: {
        channelActionResult: "idle",
        cohortActionResult: "idle",
        cohortInput: null,
        currentChannel: null,
        currentBundleId: null,
        currentReleaseId: null,
        currentCohort: null,
        crashHistoryCount: null,
        defaultChannel: null,
        detailPageMarker: null,
        detailPageTitle: null,
        diagnosticReceipt: null,
        generationEvents: null,
        channelSwitched: null,
        launchStatus: "Current Launch Status: null",
        nativeLaunchReport: null,
        startupHangBundleId: null,
        runtimeChannelInput: "beta",
        runtimeScenarioMarker: null,
        remoteConfigText: null,
        stagingBundleId: null,
        stagingReleaseId: null,
        stableBundleId: null,
        stableReleaseId: null,
        updateActionResult: "idle",
        verificationPending: null,
        startupCheckEpoch: "",
        startupCheckSettledEpoch: "",
      },
    });
  });

  it("acknowledges the exact runtime marker stored by the control plane", () => {
    resetE2eScreenState();

    expect(
      handlePatchE2eScreenState({
        runtimeScenarioMarker: "actual-bundle-marker",
      }),
    ).toMatchObject({
      screenState: { runtimeScenarioMarker: "actual-bundle-marker" },
    });
  });

  it("rejects a marker from an older launch generation after reset", () => {
    beginE2eScreenStateLaunch("launch-old");
    expect(
      handlePatchE2eScreenState({
        launchGeneration: "launch-old",
        runtimeScenarioMarker: "old-marker",
      }),
    ).toMatchObject({
      launchGeneration: "launch-old",
      screenState: { runtimeScenarioMarker: "old-marker" },
    });

    beginE2eScreenStateLaunch("launch-new");
    expect(() =>
      handlePatchE2eScreenState({
        launchGeneration: "launch-old",
        runtimeScenarioMarker: "old-marker",
      }),
    ).toThrow("stale screen state launch generation");
    expect(readE2eScreenStateSnapshot().runtimeScenarioMarker).toBeNull();
    expect(
      handlePatchE2eScreenState({
        launchGeneration: "launch-new",
        runtimeScenarioMarker: "new-marker",
      }),
    ).toMatchObject({
      launchGeneration: "launch-new",
      screenState: { runtimeScenarioMarker: "new-marker" },
    });
  });

  it("rejects a marker from an older in-process runtime generation", () => {
    beginE2eScreenStateLaunch("launch-active");
    expect(
      handlePatchE2eScreenState({
        launchGeneration: "launch-active",
        runtimeGenerationEpoch: "2",
        runtimeScenarioMarker: "replacement-marker",
      }),
    ).toMatchObject({
      runtimeGenerationEpoch: "2",
      screenState: { runtimeScenarioMarker: "replacement-marker" },
    });
    expect(() =>
      handlePatchE2eScreenState({
        launchGeneration: "launch-active",
        runtimeGenerationEpoch: "1",
        runtimeScenarioMarker: "stale-marker",
      }),
    ).toThrow("stale screen state runtime generation");
    expect(readE2eScreenStateSnapshot().runtimeScenarioMarker).toBe(
      "replacement-marker",
    );
  });

  it("resets the runtime epoch only when a new process launch is prepared", () => {
    beginE2eScreenStateLaunch("before-crash");
    handlePatchE2eScreenState({
      launchGeneration: "before-crash",
      runtimeGenerationEpoch: "2",
      runtimeScenarioMarker: "recovered-in-process",
    });
    setE2eScreenStateLaunchGeneration("before-crash");
    expect(() =>
      handlePatchE2eScreenState({
        launchGeneration: "before-crash",
        runtimeGenerationEpoch: "1",
        updateActionResult: "stale callback",
      }),
    ).toThrow("stale screen state runtime generation");

    setE2eScreenStateLaunchGeneration("after-crash");
    expect(() =>
      handlePatchE2eScreenState({
        launchGeneration: "before-crash",
        runtimeGenerationEpoch: "3",
        runtimeScenarioMarker: "late old process",
      }),
    ).toThrow("stale screen state launch generation");
    expect(
      handlePatchE2eScreenState({
        launchGeneration: "after-crash",
        runtimeGenerationEpoch: "1",
        runtimeScenarioMarker: "new process ready",
        updateActionResult: "current-channel -> adopted ID stable-release",
      }),
    ).toMatchObject({
      runtimeGenerationEpoch: "1",
      screenState: {
        runtimeScenarioMarker: "new process ready",
        updateActionResult: "current-channel -> adopted ID stable-release",
      },
    });
  });

  it("rejects ordinary evidence from a retired launch or runtime generation", () => {
    beginE2eScreenStateLaunch("launch-active");
    handlePatchE2eScreenState({
      launchGeneration: "launch-active",
      runtimeGenerationEpoch: "2",
      runtimeScenarioMarker: "replacement-marker",
    });

    expect(() =>
      handlePatchE2eScreenState({
        generationEvents: '{"latestSequence":"56"}',
        launchGeneration: "launch-retired",
        runtimeGenerationEpoch: "1",
        updateActionResult: "generation-events -> 56",
      }),
    ).toThrow("stale screen state launch generation");
    expect(() =>
      handlePatchE2eScreenState({
        generationEvents: '{"latestSequence":"56"}',
        launchGeneration: "launch-active",
        runtimeGenerationEpoch: "1",
        updateActionResult: "generation-events -> 56",
      }),
    ).toThrow("stale screen state runtime generation");
    expect(readE2eScreenStateSnapshot()).toMatchObject({
      generationEvents: null,
      runtimeScenarioMarker: "replacement-marker",
      updateActionResult: "idle",
    });
  });

  it("allows control-driver action resets after a generated launch", () => {
    beginE2eScreenStateLaunch("launch-active");

    expect(
      handlePatchE2eScreenState({ updateActionResult: "idle" }),
    ).toMatchObject({
      screenState: { updateActionResult: "idle" },
    });
  });

  it("rejects malformed screen state patches", () => {
    resetE2eScreenState();

    expect(() =>
      handlePatchE2eScreenState({ cohortActionResult: 309 }),
    ).toThrow("screen state field must be a string");
    for (const field of [
      "crashHistoryCount",
      "currentBundleId",
      "currentCohort",
      "currentReleaseId",
      "detailPageMarker",
      "detailPageTitle",
      "diagnosticReceipt",
      "generationEvents",
      "nativeLaunchReport",
      "startupHangBundleId",
    ]) {
      expect(() => handlePatchE2eScreenState({ [field]: false })).toThrow(
        "screen state field must be a string or null",
      );
    }

    expect(readE2eScreenStateSnapshot()).toEqual({
      channelActionResult: "idle",
      cohortActionResult: "idle",
      cohortInput: null,
      currentChannel: null,
      currentBundleId: null,
      currentReleaseId: null,
      currentCohort: null,
      crashHistoryCount: null,
      defaultChannel: null,
      detailPageMarker: null,
      detailPageTitle: null,
      diagnosticReceipt: null,
      generationEvents: null,
      channelSwitched: null,
      launchStatus: "Current Launch Status: null",
      nativeLaunchReport: null,
      startupHangBundleId: null,
      runtimeChannelInput: "beta",
      runtimeScenarioMarker: null,
      remoteConfigText: null,
      stagingBundleId: null,
      stagingReleaseId: null,
      stableBundleId: null,
      stableReleaseId: null,
      updateActionResult: "idle",
      verificationPending: null,
      startupCheckEpoch: "",
      startupCheckSettledEpoch: "",
    });
  });

  it("ignores stale startup completion and preserves a focused Android runtime's epoch", () => {
    resetE2eScreenState();
    const first = prepareE2eStartupCheck().startupCheckEpoch;
    handlePatchE2eScreenState({ startupCheckSettledEpoch: first });
    expect(prepareE2eStartupCheck(true).startupCheckEpoch).toBe(first);
    expect(readE2eScreenStateSnapshot().startupCheckSettledEpoch).toBe(first);

    const current = prepareE2eStartupCheck().startupCheckEpoch;
    expect(current).not.toBe(first);
    handlePatchE2eScreenState({ startupCheckSettledEpoch: first });
    expect(readE2eScreenStateSnapshot().startupCheckSettledEpoch).toBe("");
    handlePatchE2eScreenState({ startupCheckSettledEpoch: current });
    expect(readE2eScreenStateSnapshot().startupCheckSettledEpoch).toBe(current);
  });
});
