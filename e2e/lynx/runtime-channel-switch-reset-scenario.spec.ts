import { describe, expect, it } from "vitest";

import { getLynxScenarioDefinition, listLynxScenarioNames } from "./scenarios";
import { lynxRuntimeChannelSwitchResetScenario } from "./scenarios/runtime-channel-switch-reset";

describe("Lynx runtime channel reset scenario", () => {
  it("replaces the shared screen-receipt scenario with native generation evidence", () => {
    expect(getLynxScenarioDefinition("runtime-channel-switch-reset")).toBe(
      lynxRuntimeChannelSwitchResetScenario,
    );
    expect(
      listLynxScenarioNames().filter(
        (name) => name === "runtime-channel-switch-reset",
      ),
    ).toEqual(["runtime-channel-switch-reset"]);
  });
});
