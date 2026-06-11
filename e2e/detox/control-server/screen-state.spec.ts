import { describe, expect, it } from "vitest";

import {
  handlePatchE2eScreenState,
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
    });
  });
});
