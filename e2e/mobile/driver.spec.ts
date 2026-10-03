import type { Locator } from "e2e";
import { describe, expect, it, vi } from "vitest";

import { MobileAppDriver } from "./driver.ts";
import { RAW_TEXT_ATTRIBUTE } from "./engine.ts";

function fixture() {
  const calls: string[] = [];
  const controller = new AbortController();
  const locator = {
    waitFor: vi.fn(async () => {
      calls.push("visible");
    }),
    getAttribute: vi.fn(async () => "Current Launch Status: UPDATE_APPLIED"),
    tap: vi.fn(async () => {
      calls.push("tap");
    }),
    fill: vi.fn(async () => {
      calls.push("fill");
    }),
  };
  const client = {
    postJson: vi.fn(
      async (
        _stage: string,
        path: string,
        _body?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        calls.push(path);
        return {};
      },
    ),
    runJob: vi.fn(
      async (
        _stage: string,
        path: string,
        _body?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        calls.push(path);
        return {};
      },
    ),
    waitForScreenStateField: vi.fn(async () => {
      calls.push("wait-result");
      return {};
    }),
  };
  const device = {
    closeApp: vi.fn(async () => {
      calls.push("close");
    }),
    openApp: vi.fn(async () => {
      calls.push("open");
    }),
    openLink: vi.fn(async () => {
      calls.push("link");
    }),
  };
  const screen = { getByTestId: vi.fn(() => locator as unknown as Locator) };
  const app = new MobileAppDriver({
    appId: "org.example.app",
    assertionTimeoutMs: 0,
    client,
    device,
    initialValues: { builtInBundleId: "builtin" },
    launchArguments: ["-RUNTIME_URL", "http://localhost"],
    platform: "ios",
    screen,
    signal: controller.signal,
  });
  return { app, calls, client, controller, device, locator, screen };
}

describe("MobileAppDriver", () => {
  it("resets stale action output, opens its route once and waits without a duplicate tap", async () => {
    const f = fixture();
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.calls).toEqual([
      "/e2e/screen-state",
      "link",
      "visible",
      "wait-result",
    ]);
    expect(f.client.postJson).toHaveBeenCalledWith(
      "install: reset updateActionResult",
      "/e2e/screen-state",
      { updateActionResult: "idle" },
    );
    expect(f.device.openLink).toHaveBeenCalledWith(
      "hotupdaterexample://e2e/action/install-current-channel-update",
      { app: "org.example.app" },
    );
    expect(f.locator.tap).not.toHaveBeenCalled();
    await f.app.tap("install again", "action-install-current-channel-update");
    expect(f.device.openLink).toHaveBeenCalledTimes(2);
  });

  it("accepts substring alternatives as OR and preserves exact whitespace", async () => {
    const f = fixture();
    await f.app.assertText("status", "launch-status-result", [
      "UNCHANGED",
      "UPDATE_APPLIED",
    ]);
    expect(f.locator.getAttribute).toHaveBeenCalledWith(RAW_TEXT_ATTRIBUTE);
    f.locator.getAttribute.mockResolvedValue(
      "current-channel  -> installed ID release",
    );
    await expect(
      f.app.assertText(
        "result",
        "update-action-result",
        "current-channel -> installed ID release",
        { exactText: true },
      ),
    ).rejects.toThrow("to equal");
    expect(f.client.waitForScreenStateField).toHaveBeenCalledWith(
      "result: wait updateActionResult exact",
      "updateActionResult",
      {
        expectedValue: "current-channel -> installed ID release",
        rejectValues: ["idle"],
        rejectSubstrings: [" -> checking"],
      },
    );
  });

  it("does not mask ambiguous native test IDs", async () => {
    const f = fixture();
    f.locator.waitFor.mockRejectedValue(new Error("LOCATOR_AMBIGUOUS"));
    await expect(
      f.app.assertText("status", "runtime-bundle-id", "builtin"),
    ).rejects.toThrow("LOCATOR_AMBIGUOUS");
    expect(f.locator.getAttribute).not.toHaveBeenCalled();
  });

  it("resolves nested placeholders and saved aliases without stringifying typed values", async () => {
    const f = fixture();
    f.client.runJob.mockResolvedValueOnce({
      bundleId: "ota",
      releaseId: "r1",
      count: 2,
    });
    await f.app.control(
      "deploy",
      "/e2e/jobs/deploy-bundle",
      {},
      {
        saveResultAs: "stableBundleId",
        saveResultFieldsAs: { releaseId: "stableReleaseId" },
      },
    );
    await f.app.control("verify", "/e2e/assert-metadata-active", {
      bundleId: "$stableBundleId",
      releaseId: "$stableReleaseId",
      safe: ["$builtInBundleId"],
      count: "$count",
      marker: "bundle=$stableBundleId",
    });
    expect(f.client.postJson).toHaveBeenLastCalledWith(
      "verify",
      "/e2e/assert-metadata-active",
      {
        bundleId: "ota",
        releaseId: "r1",
        safe: ["builtin"],
        count: 2,
        marker: "bundle=ota",
      },
    );
    await expect(
      f.app.control("missing", "/e2e/screen-state", { value: "$missing" }),
    ).rejects.toThrow("Missing scenario value: missing");
  });

  it("fills text and persists the input patch used by action routes", async () => {
    const f = fixture();
    await f.app.typeText("cohort", "cohort-input", "$builtInBundleId");
    expect(f.locator.fill).toHaveBeenCalledWith("builtin");
    expect(f.client.postJson).toHaveBeenLastCalledWith(
      "cohort: patch cohortInput",
      "/e2e/screen-state",
      { cohortInput: "builtin" },
    );
  });

  it("retains controller reset and prepares every fresh launch without reinstalling", async () => {
    const f = fixture();
    await f.app.launch("launch");
    await f.app.reload("reload");
    await f.app.resetAppState("reset");
    expect(f.calls).toEqual([
      "/e2e/prepare-app-launch",
      "open",
      "/e2e/terminate-app",
      "/e2e/prepare-app-launch",
      "open",
      "/e2e/reset-local-app-state",
      "open",
    ]);
    expect(f.device.openApp).toHaveBeenLastCalledWith("org.example.app", {
      relaunch: true,
      launchArguments: ["-RUNTIME_URL", "http://localhost"],
    });
  });

  it("waits for crash recovery evidence before a disconnect can lead to UI navigation", async () => {
    const f = fixture();
    f.device.openApp.mockRejectedValueOnce(new Error("app disconnected"));
    await f.app.launch("crash", { expectCrash: true });
    expect(f.app.expectedLaunchFailures).toBe(0);
    await expect(
      f.app.assertText("premature", "runtime-bundle-id", "builtin"),
    ).rejects.toThrow("Native recovery must be verified");
    expect(f.device.openLink).not.toHaveBeenCalled();
    await f.app.control("native recovery", "/e2e/wait-for-crash-recovery", {
      crashedBundleId: "bad",
      stableBundleId: "builtin",
    });
    expect(f.device.openApp).toHaveBeenCalledTimes(1);
    expect(f.app.expectedLaunchFailures).toBe(1);
    f.locator.getAttribute.mockResolvedValue("builtin");
    await f.app.assertText("recovered", "runtime-bundle-id", "builtin");
  });

  it("terminates externally launched hung apps through the pinned control target without reopening them", async () => {
    const f = fixture();
    f.device.closeApp.mockRejectedValue(new Error("no automation session"));
    await f.app.terminate("stop before hang");
    await f.app.control("launch hang", "/e2e/launch-startup-hang", {
      bundleId: "hung",
    });
    await f.app.terminate("force-kill hang");
    expect(f.calls).toEqual([
      "/e2e/terminate-app",
      "/e2e/launch-startup-hang",
      "/e2e/terminate-app",
    ]);
    expect(f.device.closeApp).not.toHaveBeenCalled();
    expect(f.device.openApp).not.toHaveBeenCalled();
    f.client.postJson.mockRejectedValueOnce(new Error("device offline"));
    await expect(f.app.terminate("failed kill")).rejects.toThrow(
      "device offline",
    );
  });

  it("never records an ordinary launch error or unverified recovery as expected", async () => {
    const f = fixture();
    f.device.openApp.mockRejectedValue(
      new Error("unexpected transport failure"),
    );
    await expect(f.app.launch("ordinary launch")).rejects.toThrow(
      "unexpected transport failure",
    );
    expect(f.app.expectedLaunchFailures).toBe(0);
    await f.app.launch("crash launch", { expectCrash: true });
    f.client.postJson.mockRejectedValue(new Error("native recovery failed"));
    await expect(
      f.app.control("recovery", "/e2e/wait-for-crash-recovery", {}),
    ).rejects.toThrow("native recovery failed");
    expect(f.app.expectedLaunchFailures).toBe(0);
    await expect(f.app.verifyConsoleInsights(0)).rejects.toThrow(
      "Native recovery evidence is missing",
    );
  });

  it("observes without opening or foregrounding when ensureForeground is false", async () => {
    const f = fixture();
    await f.app.assertText(
      "observe recovery",
      "launch-status-result",
      "UPDATE_APPLIED",
      { ensureForeground: false },
    );
    expect(f.device.openApp).not.toHaveBeenCalled();
    expect(f.device.openLink).not.toHaveBeenCalled();
  });

  it("fences a continuation that becomes ready after teardown aborted it", async () => {
    const f = fixture();
    f.locator.waitFor.mockImplementationOnce(async () => {
      f.controller.abort(new Error("attempt ended"));
    });
    await expect(
      f.app.typeText("late input", "cohort-input", "late"),
    ).rejects.toThrow("attempt ended");
    expect(f.locator.fill).not.toHaveBeenCalled();
    expect(f.client.postJson).not.toHaveBeenCalled();
    await expect(f.app.launch("late launch")).rejects.toThrow("attempt ended");
    expect(f.device.openApp).not.toHaveBeenCalled();
  });

  it("preserves the per-scenario Console Insights assertion", async () => {
    const f = fixture();
    f.client.postJson.mockResolvedValue({ verified: true });
    await expect(f.app.verifyConsoleInsights(123)).resolves.toEqual({
      verified: true,
    });
    expect(f.client.postJson).toHaveBeenCalledWith(
      "verify Console Insights",
      "/e2e/verify-console-insights",
      { sinceMs: 123 },
    );
  });
});
