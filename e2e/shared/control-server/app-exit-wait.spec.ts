import { describe, expect, it } from "vitest";

import {
  advanceAppExitWait,
  describeAppExitWaitFailure,
  hasPostContentCrashAfterMarker,
  initialAppExitWaitState,
  isAppExitProved,
  postContentCrashLogLine,
} from "./app-exit-wait.ts";

const crashLine = postContentCrashLogLine("bundle-b");

describe("App exit after a post-content crash", () => {
  it("counts only the crash the current launch logged", () => {
    expect(
      hasPostContentCrashAfterMarker(
        `${crashLine}\nlaunch-2`,
        "launch-2",
        "bundle-b",
      ),
    ).toBe(false);
    expect(
      hasPostContentCrashAfterMarker(
        `launch-1\n${crashLine}\nlaunch-2\n${crashLine}`,
        "launch-2",
        "bundle-b",
      ),
    ).toBe(true);
    // Logs that lost the launch marker prove nothing about this launch.
    expect(
      hasPostContentCrashAfterMarker(crashLine, "launch-2", "bundle-b"),
    ).toBe(false);
    // A stream started after the launch holds only this launch's lines.
    expect(hasPostContentCrashAfterMarker(crashLine, null, "bundle-b")).toBe(
      true,
    );
  });

  it("never takes another bundle's crash for this one", () => {
    expect(
      hasPostContentCrashAfterMarker(
        `launch\n${postContentCrashLogLine("bundle-a")}`,
        "launch",
        "bundle-b",
      ),
    ).toBe(false);
  });

  it("requires the bundle's fatal and a process that stays stopped", () => {
    let state = initialAppExitWaitState;
    state = advanceAppExitWait(state, { crashLogged: false, running: false });
    state = advanceAppExitWait(state, { crashLogged: false, running: false });
    state = advanceAppExitWait(state, { crashLogged: false, running: false });
    // Stopped without the fatal: a reload, a kill, or another crash.
    expect(isAppExitProved(state, 3)).toBe(false);
    expect(describeAppExitWaitFailure(state, "bundle-b")).toBe(
      "The app stopped without bundle bundle-b's post-content crash",
    );

    state = advanceAppExitWait(state, { crashLogged: true, running: true });
    // The fatal was logged, but a running probe restarts the stopped count.
    expect(state).toEqual({ crashLogged: true, stoppedObservations: 0 });
    expect(isAppExitProved(state, 3)).toBe(false);
    expect(describeAppExitWaitFailure(state, "bundle-b")).toBe(
      "Bundle bundle-b logged its post-content crash, but the app did not stay stopped",
    );

    state = advanceAppExitWait(state, { crashLogged: false, running: false });
    state = advanceAppExitWait(state, { crashLogged: false, running: false });
    expect(isAppExitProved(state, 3)).toBe(false);
    state = advanceAppExitWait(state, { crashLogged: false, running: false });
    expect(isAppExitProved(state, 3)).toBe(true);
  });

  it("reports a bundle that kept running without its fatal", () => {
    const state = advanceAppExitWait(initialAppExitWaitState, {
      crashLogged: false,
      running: true,
    });
    expect(isAppExitProved(state, 1)).toBe(false);
    expect(describeAppExitWaitFailure(state, "bundle-b")).toBe(
      "Bundle bundle-b never reached its post-content crash, and the app kept running",
    );
  });
});
