import type { Locator, Screen } from "e2e";
import { describe, expect, it, vi } from "vitest";

import { MobileAppDriver } from "./driver.ts";
import { RAW_TEXT_ATTRIBUTE } from "./engine.ts";
import type { IosAlert } from "./ios-alert.ts";

function fixture(platform: "ios" | "android" = "ios", assertionTimeoutMs = 0) {
  const calls: string[] = [];
  const controller = new AbortController();
  const locator = {
    isVisible: vi.fn(async () => true),
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
    waitForScreenStateField: vi.fn(
      async (
        _stage: string,
        _field: string,
        options?: { onPending?: () => Promise<void> },
      ) => {
        await options?.onPending?.();
        calls.push("wait-result");
        return {};
      },
    ),
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
  const openButton = {
    tap: vi.fn(async () => {
      calls.push("confirm-link");
    }),
  };
  const confirmation = {
    getByRole: vi.fn(
      (_role: string, _name: string) => openButton as unknown as Locator,
    ),
  };
  const getByRole = vi.fn(
    (_role: string, _name: unknown) => confirmation as unknown as Locator,
  );
  const screen = {
    getByTestId: vi.fn(() => locator as unknown as Locator),
    getByRole: getByRole as Screen["getByRole"],
  };
  const iosAlert = { get: vi.fn(async (): Promise<IosAlert | null> => null) };
  const app = new MobileAppDriver({
    appId: "org.example.app",
    assertionTimeoutMs,
    client,
    device,
    iosAlert,
    initialValues: { builtInBundleId: "builtin" },
    launchArguments: ["-RUNTIME_URL", "http://localhost"],
    platform,
    screen,
    signal: controller.signal,
  });
  return {
    app,
    calls,
    client,
    controller,
    device,
    locator,
    screen,
    iosAlert,
    getByRole,
    confirmation,
    openButton,
  };
}

describe("MobileAppDriver", () => {
  it("resets stale action output, opens its route once and waits without a duplicate tap", async () => {
    const f = fixture();
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.calls).toEqual(["/e2e/screen-state", "link", "wait-result"]);
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

  it.each([
    {
      title: "‘HotUpdaterExample’에서 열겠습니까?",
      buttons: ["취소", "열기"],
      affirmative: "열기",
    },
    {
      title: "Open in “HotUpdaterExample”?",
      buttons: ["Cancel", "Open"],
      affirmative: "Open",
    },
  ])(
    "confirms only the expected app dialog without post-action UI reads: $title",
    async ({ title, buttons, affirmative }) => {
      const f = fixture();
      f.iosAlert.get.mockResolvedValue({ title, buttons });
      f.client.waitForScreenStateField.mockImplementation(
        async (_stage, _field, options) => {
          await options?.onPending?.();
          await options?.onPending?.();
          return {};
        },
      );
      await f.app.tap("install", "action-install-current-channel-update");
      expect(f.getByRole).toHaveBeenCalledWith("alert", title);
      expect(f.confirmation.getByRole).toHaveBeenCalledWith(
        "button",
        affirmative,
      );
      expect(f.openButton.tap).toHaveBeenCalledTimes(1);
      expect(f.iosAlert.get).toHaveBeenCalledTimes(1);
      expect(f.device.openLink).toHaveBeenCalledTimes(1);
      expect(f.locator.isVisible).not.toHaveBeenCalled();
      expect(f.locator.waitFor).not.toHaveBeenCalled();
      expect(f.locator.tap).not.toHaveBeenCalled();
      expect(f.device.openApp).not.toHaveBeenCalled();
    },
  );

  it("verifies the exact app dialog when the pinned native getter reports its Korean scrollbar", async () => {
    const f = fixture();
    f.iosAlert.get.mockResolvedValue({
      title: "수직 스크롤 막대, 1페이지",
      buttons: ["취소", "열기"],
    });
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.getByRole).toHaveBeenCalledWith("alert", expect.any(RegExp));
    const title = f.getByRole.mock.calls[0]![1] as RegExp;
    expect(title.test("‘HotUpdaterExample’에서 열겠습니까?")).toBe(true);
    expect(title.test("‘AnotherApp’에서 열겠습니까?")).toBe(false);
    expect(title.test("수직 스크롤 막대, 1페이지")).toBe(false);
    expect(f.confirmation.getByRole).toHaveBeenCalledWith("button", "열기");
    expect(f.openButton.tap).toHaveBeenCalledTimes(1);
    expect(f.locator.waitFor).not.toHaveBeenCalled();
  });

  it("never taps another app dialog hidden by the same native scrollbar-title bug", async () => {
    const f = fixture();
    f.iosAlert.get.mockResolvedValue({
      title: "수직 스크롤 막대, 1페이지",
      buttons: ["취소", "열기"],
    });
    f.getByRole.mockImplementation((_role, title) => {
      // A lazy locator for the real visible dialog cannot resolve this scope.
      const matches =
        title instanceof RegExp && title.test("‘AnotherApp’에서 열겠습니까?");
      return {
        getByRole: () => ({
          tap: async () => {
            if (!matches) throw new Error("No matching expected app alert");
            await f.openButton.tap();
          },
        }),
      } as unknown as Locator;
    });
    await expect(
      f.app.tap("install", "action-install-current-channel-update"),
    ).rejects.toThrow("No matching expected app alert");
    expect(f.openButton.tap).not.toHaveBeenCalled();
    expect(f.locator.waitFor).not.toHaveBeenCalled();
    expect(f.device.openApp).not.toHaveBeenCalled();
  });

  it("waits for a delayed action confirmation with native reads only", async () => {
    const f = fixture();
    f.iosAlert.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        title: "‘HotUpdaterExample’에서 열겠습니까?",
        buttons: ["취소", "열기"],
      });
    f.client.waitForScreenStateField.mockImplementation(
      async (_stage, _field, options) => {
        for (let i = 0; i < 4; i++) await options?.onPending?.();
        return {};
      },
    );
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.iosAlert.get).toHaveBeenCalledTimes(3);
    expect(f.openButton.tap).toHaveBeenCalledTimes(1);
    expect(f.locator.isVisible).not.toHaveBeenCalled();
    expect(f.locator.waitFor).not.toHaveBeenCalled();
  });

  it("does not inspect alerts after the mapped action result is already terminal", async () => {
    const f = fixture();
    f.client.waitForScreenStateField.mockResolvedValue({});
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.iosAlert.get).not.toHaveBeenCalled();
    expect(f.getByRole).not.toHaveBeenCalled();
    expect(f.locator.isVisible).not.toHaveBeenCalled();
    expect(f.locator.waitFor).not.toHaveBeenCalled();
  });

  it("does not inspect or foreground the app after an action link when no confirmation exists", async () => {
    const f = fixture();
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.iosAlert.get).toHaveBeenCalledTimes(1);
    expect(f.getByRole).not.toHaveBeenCalled();
    expect(f.locator.isVisible).not.toHaveBeenCalled();
    expect(f.locator.waitFor).not.toHaveBeenCalled();
    expect(f.device.openApp).not.toHaveBeenCalled();
  });

  it.each([
    { title: "‘AnotherApp’에서 열겠습니까?", buttons: ["취소", "열기"] },
    { title: "Open in “AnotherApp”?", buttons: ["Cancel", "Open"] },
    {
      title: "“HotUpdaterExample” Would Like to Send You Notifications",
      buttons: ["Don't Allow", "Allow"],
    },
    { title: "‘HotUpdaterExample’에서 열겠습니까?", buttons: ["취소", "허용"] },
  ])("preserves an unrelated or unsupported alert: $title", async (alert) => {
    const f = fixture();
    f.iosAlert.get.mockResolvedValue(alert);
    await expect(
      f.app.tap("install", "action-install-current-channel-update"),
    ).rejects.toThrow("Unexpected iOS alert");
    expect(f.getByRole).not.toHaveBeenCalled();
    expect(f.openButton.tap).not.toHaveBeenCalled();
    expect(f.locator.waitFor).not.toHaveBeenCalled();
  });

  it("waits for a delayed confirmation during ordinary screen navigation", async () => {
    const f = fixture("ios", 1_000);
    f.locator.isVisible.mockResolvedValue(false);
    f.iosAlert.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
      title: "‘HotUpdaterExample’에서 열겠습니까?",
      buttons: ["취소", "열기"],
    });
    await f.app.assertText(
      "read status",
      "launch-status-result",
      "UPDATE_APPLIED",
    );
    expect(f.iosAlert.get).toHaveBeenCalledTimes(2);
    expect(f.calls.indexOf("confirm-link")).toBeLessThan(
      f.calls.indexOf("visible"),
    );
  });

  it("skips iOS confirmation handling on Android and while observing native recovery", async () => {
    const android = fixture("android");
    await android.app.tap("install", "action-install-current-channel-update");
    expect(android.iosAlert.get).not.toHaveBeenCalled();
    const ios = fixture();
    await ios.app.assertText(
      "observe",
      "launch-status-result",
      "UPDATE_APPLIED",
      { ensureForeground: false },
    );
    expect(ios.iosAlert.get).not.toHaveBeenCalled();
  });

  it("fences confirmation when teardown aborts during the native query", async () => {
    const f = fixture();
    f.iosAlert.get.mockImplementation(async () => {
      f.controller.abort(new Error("attempt ended"));
      return {
        title: "‘HotUpdaterExample’에서 열겠습니까?",
        buttons: ["취소", "열기"],
      };
    });
    await expect(
      f.app.tap("install", "action-install-current-channel-update"),
    ).rejects.toThrow("attempt ended");
    expect(f.getByRole).not.toHaveBeenCalled();
    expect(f.openButton.tap).not.toHaveBeenCalled();
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
