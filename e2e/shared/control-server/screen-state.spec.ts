import { describe, expect, it } from "vitest";

import {
  handlePatchE2eScreenState,
  prepareE2eStartupCheck,
  readE2eScreenStateSnapshot,
  resetE2eScreenState,
} from "./screen-state.ts";

describe("E2E screen state control boundary", () => {
  it("patches and resets remount-safe screen state", () => {
    resetE2eScreenState();

    handlePatchE2eScreenState({
      cohortActionResult: "set -> qa",
      cohortInput: "qa",
      runtimeChannelInput: "beta-next",
    });

    expect(readE2eScreenStateSnapshot()).toMatchObject({
      cohortActionResult: "set -> qa",
      cohortInput: "qa",
      runtimeChannelInput: "beta-next",
    });

    expect(resetE2eScreenState()).toEqual({
      screenState: {
        channelActionResult: "idle",
        cohortActionResult: "idle",
        cohortInput: null,
        runtimeChannelInput: "beta",
        updateActionResult: "idle",
        startupCheckEpoch: "",
        startupCheckSettledEpoch: "",
      },
    });
  });

  it("rejects malformed screen state patches", () => {
    resetE2eScreenState();

    expect(() =>
      handlePatchE2eScreenState({ cohortActionResult: 309 }),
    ).toThrow("screen state field must be a string");

    expect(readE2eScreenStateSnapshot()).toEqual({
      channelActionResult: "idle",
      cohortActionResult: "idle",
      cohortInput: null,
      runtimeChannelInput: "beta",
      updateActionResult: "idle",
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
