import type { Locator, Screen } from "e2e";
import { describe, expect, it, vi } from "vitest";

import { MobileAppDriver } from "./driver.ts";
import type { IosAlert } from "./ios-alert.ts";

const pollSettled = vi.hoisted(() => vi.fn());

// The SDK's matchers poll a real engine. Here each fake locator answers its own
// matchers, and expect.poll samples like the SDK's: a throwing read is retried.
vi.mock("e2e", () => ({
  expect: Object.assign((target: { matchers: object }) => target.matchers, {
    poll: (read: () => Promise<unknown>) => ({
      async toBe(value: unknown) {
        let last: unknown = new Error("expect.poll timed out");
        for (let sample = 0; sample < 20; sample++) {
          try {
            if ((await read()) === value) return pollSettled();
          } catch (error) {
            last = error;
          }
        }
        throw last;
      },
    }),
  }),
}));

function fixture(platform: "ios" | "android" = "ios") {
  const calls: string[] = [];
  const controller = new AbortController();
  const locator = {
    text: "Current Launch Status: UPDATE_APPLIED",
    isVisible: vi.fn(async () => true),
    tap: vi.fn(async () => {
      calls.push("tap");
    }),
    fill: vi.fn(async () => {
      calls.push("fill");
    }),
    matchers: {
      toBeVisible: vi.fn(async () => {
        calls.push("visible");
      }),
      toHaveText: vi.fn(async (expected: string) => {
        calls.push("text");
        if (locator.text !== expected)
          throw new Error(`expected text ${expected}, got ${locator.text}`);
      }),
      toContainText: vi.fn(async (expected: string | RegExp) => {
        calls.push("text");
        const found =
          typeof expected === "string"
            ? locator.text.includes(expected)
            : expected.test(locator.text);
        if (!found)
          throw new Error(`expected text containing ${String(expected)}`);
      }),
    },
  };
  const client = {
    postJson: vi.fn(
      async (
        _stage: string,
        path: string,
        _body?: Record<string, unknown>,
      ): Promise<Record<string, unknown>> => {
        calls.push(path);
        return path === "/e2e/prepare-app-launch"
          ? { startupCheckEpoch: "fixture-epoch" }
          : {};
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
    // An action route reports progress as soon as the app has opened it.
    readScreenStateField: vi.fn(
      async (_field: string): Promise<string | undefined> =>
        "current-channel -> checking",
    ),
    waitForScreenStateField: vi.fn(
      async (_stage: string, _field: string, _options?: object) => {
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
    client,
    device,
    iosAlert,
    initialValues: { builtInBundleId: "builtin" },
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
      f.client.readScreenStateField.mockResolvedValue("idle");
      f.iosAlert.get.mockResolvedValue({ title, buttons });
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
      expect(f.locator.matchers.toBeVisible).not.toHaveBeenCalled();
      expect(f.locator.tap).not.toHaveBeenCalled();
      expect(f.device.openApp).not.toHaveBeenCalled();
    },
  );

  it("verifies the exact app dialog when the pinned native getter reports its Korean scrollbar", async () => {
    const f = fixture();
    f.client.readScreenStateField.mockResolvedValue("idle");
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
    expect(f.locator.matchers.toBeVisible).not.toHaveBeenCalled();
  });

  it("never taps another app dialog hidden by the same native scrollbar-title bug", async () => {
    const f = fixture();
    f.client.readScreenStateField.mockResolvedValue("idle");
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
    expect(f.locator.matchers.toBeVisible).not.toHaveBeenCalled();
    expect(f.device.openApp).not.toHaveBeenCalled();
  });

  it("waits for a delayed action confirmation with native reads only", async () => {
    const f = fixture();
    f.client.readScreenStateField.mockResolvedValue("idle");
    f.iosAlert.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        title: "‘HotUpdaterExample’에서 열겠습니까?",
        buttons: ["취소", "열기"],
      });
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.iosAlert.get).toHaveBeenCalledTimes(3);
    expect(f.openButton.tap).toHaveBeenCalledTimes(1);
    expect(f.locator.isVisible).not.toHaveBeenCalled();
    expect(f.locator.matchers.toBeVisible).not.toHaveBeenCalled();
  });

  it("does not inspect alerts once the action route has started", async () => {
    const f = fixture();
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.client.readScreenStateField).toHaveBeenCalledExactlyOnceWith(
      "updateActionResult",
    );
    expect(f.iosAlert.get).not.toHaveBeenCalled();
    expect(f.getByRole).not.toHaveBeenCalled();
    expect(f.locator.isVisible).not.toHaveBeenCalled();
    expect(f.locator.matchers.toBeVisible).not.toHaveBeenCalled();
  });

  it("does not inspect or foreground the app after an action link when no confirmation exists", async () => {
    const f = fixture();
    f.client.readScreenStateField.mockResolvedValueOnce("idle");
    await f.app.tap("install", "action-install-current-channel-update");
    expect(f.iosAlert.get).toHaveBeenCalledTimes(1);
    expect(f.getByRole).not.toHaveBeenCalled();
    expect(f.locator.isVisible).not.toHaveBeenCalled();
    expect(f.locator.matchers.toBeVisible).not.toHaveBeenCalled();
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
    f.client.readScreenStateField.mockResolvedValue("idle");
    f.iosAlert.get.mockResolvedValue(alert);
    await expect(
      f.app.tap("install", "action-install-current-channel-update"),
    ).rejects.toThrow("Unexpected iOS alert");
    expect(f.getByRole).not.toHaveBeenCalled();
    expect(f.openButton.tap).not.toHaveBeenCalled();
    expect(f.locator.matchers.toBeVisible).not.toHaveBeenCalled();
  });

  it("waits for a delayed confirmation during ordinary screen navigation", async () => {
    const f = fixture("ios");
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
      f.calls.indexOf("text"),
    );
  });

  it("accepts the app-link dialog once, after a navigation poll that only reads", async () => {
    const f = fixture();
    pollSettled.mockClear();
    f.locator.isVisible.mockResolvedValue(false);
    f.iosAlert.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
      title: "Open in “HotUpdaterExample”?",
      buttons: ["Cancel", "Open"],
    });
    await f.app.assertText(
      "read status",
      "launch-status-result",
      "UPDATE_APPLIED",
    );
    expect(f.openButton.tap).toHaveBeenCalledTimes(1);
    expect(pollSettled).toHaveBeenCalledTimes(1);
    expect(pollSettled.mock.invocationCallOrder[0]).toBeLessThan(
      f.openButton.tap.mock.invocationCallOrder[0]!,
    );
  });

  it("refuses an unexpected alert during screen navigation at once", async () => {
    const f = fixture();
    f.locator.isVisible.mockResolvedValue(false);
    f.iosAlert.get.mockResolvedValue({
      title: "“HotUpdaterExample” Would Like to Send You Notifications",
      buttons: ["Don't Allow", "Allow"],
    });
    await expect(
      f.app.assertText("read status", "launch-status-result", "UPDATE_APPLIED"),
    ).rejects.toThrow("Unexpected iOS alert");
    expect(f.iosAlert.get).toHaveBeenCalledTimes(1);
    expect(f.getByRole).not.toHaveBeenCalled();
    expect(f.locator.matchers.toContainText).not.toHaveBeenCalled();
  });

  it("rethrows a read error from the iOS route wait at once", async () => {
    const f = fixture();
    const ambiguous = new Error("LOCATOR_AMBIGUOUS");
    f.locator.isVisible.mockRejectedValue(ambiguous);
    await expect(
      f.app.assertText("read status", "launch-status-result", "UPDATE_APPLIED"),
    ).rejects.toBe(ambiguous);
    expect(f.locator.isVisible).toHaveBeenCalledTimes(1);
    expect(f.iosAlert.get).not.toHaveBeenCalled();
    expect(f.locator.matchers.toContainText).not.toHaveBeenCalled();
  });

  it("skips iOS confirmation handling on Android and while observing native recovery", async () => {
    const android = fixture("android");
    await android.app.tap("install", "action-install-current-channel-update");
    expect(android.iosAlert.get).not.toHaveBeenCalled();
    expect(android.client.readScreenStateField).not.toHaveBeenCalled();
    expect(android.device.openApp).not.toHaveBeenCalled();
    expect(android.calls).toEqual(["/e2e/screen-state", "link", "wait-result"]);
    const ios = fixture();
    await ios.app.assertText(
      "observe",
      "launch-status-result",
      "UPDATE_APPLIED",
      { ensureForeground: false },
    );
    expect(ios.iosAlert.get).not.toHaveBeenCalled();
  });

  it("uses the Android route link to foreground while retaining foreground-only same-route reads", async () => {
    const f = fixture("android");
    await f.app.assertText(
      "read status",
      "launch-status-result",
      "UPDATE_APPLIED",
    );
    expect(f.device.openApp).not.toHaveBeenCalled();
    expect(f.device.openLink).toHaveBeenCalledExactlyOnceWith(
      "hotupdaterexample://e2e/launch-status",
      { app: "org.example.app" },
    );
    expect(f.calls).toEqual(["link", "text"]);
    expect(f.locator.matchers.toContainText).toHaveBeenCalledExactlyOnceWith(
      "UPDATE_APPLIED",
    );

    await f.app.assertText(
      "read status again",
      "launch-status-result",
      "UPDATE_APPLIED",
    );
    expect(f.device.openApp).toHaveBeenCalledExactlyOnceWith(
      "org.example.app",
      { relaunch: false },
    );
    expect(f.device.openLink).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual(["link", "text", "open", "text"]);
    expect(f.locator.matchers.toContainText).toHaveBeenCalledTimes(2);
  });

  it("propagates Android route failures without reopening the app or reading UI", async () => {
    const f = fixture("android");
    const error = new Error("route could not be opened");
    f.device.openLink.mockRejectedValueOnce(error);
    await expect(
      f.app.assertText("read status", "launch-status-result", "UPDATE_APPLIED"),
    ).rejects.toBe(error);
    expect(f.device.openLink).toHaveBeenCalledTimes(1);
    expect(f.device.openApp).not.toHaveBeenCalled();
    expect(f.locator.matchers.toBeVisible).not.toHaveBeenCalled();
    expect(f.locator.matchers.toContainText).not.toHaveBeenCalled();
  });

  it("fences confirmation when teardown aborts during the native query", async () => {
    const f = fixture();
    f.client.readScreenStateField.mockResolvedValue("idle");
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

  it("accepts substring alternatives as OR and matches exact text", async () => {
    const f = fixture();
    await f.app.assertText("status", "launch-status-result", [
      "Status: UNCHANGED",
      "Status: UPDATE_APPLIED",
    ]);
    const anyOf = f.locator.matchers.toContainText.mock.calls[0]![0];
    expect(anyOf).toBeInstanceOf(RegExp);
    expect((anyOf as RegExp).test("Current Launch Status: UNCHANGED")).toBe(
      true,
    );
    expect((anyOf as RegExp).test("Status: UPDATE")).toBe(false);
    // Alternatives are literal text, not patterns.
    f.locator.text = "value (c)";
    await f.app.assertText("literal", "launch-status-result", ["a.b", "(c)"]);
    const literal = f.locator.matchers.toContainText.mock.calls[1]![0];
    expect((literal as RegExp).test("axb")).toBe(false);
    expect((literal as RegExp).test("c")).toBe(false);
    // Alternatives are normalized like the text they are matched against.
    f.locator.text = "Status: A";
    await f.app.assertText("spaced", "launch-status-result", [
      "Status:  A\n",
      "Status: B",
    ]);
    await expect(
      f.app.assertText("nothing expected", "launch-status-result", []),
    ).rejects.toThrow("at least one expected value");
    f.locator.text = "current-channel -> installed ID other";
    await expect(
      f.app.assertText(
        "result",
        "update-action-result",
        "current-channel -> installed ID release",
        { exactText: true },
      ),
    ).rejects.toThrow("expected text current-channel -> installed ID release");
    expect(f.locator.matchers.toHaveText).toHaveBeenCalledExactlyOnceWith(
      "current-channel -> installed ID release",
    );
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
    f.locator.matchers.toBeVisible.mockRejectedValue(
      new Error("LOCATOR_AMBIGUOUS"),
    );
    await expect(
      f.app.typeText("cohort", "cohort-input", "qa"),
    ).rejects.toThrow("LOCATOR_AMBIGUOUS");
    expect(f.locator.fill).not.toHaveBeenCalled();
    f.locator.matchers.toContainText.mockRejectedValue(
      new Error("LOCATOR_AMBIGUOUS"),
    );
    await expect(
      f.app.assertText("status", "runtime-bundle-id", "builtin"),
    ).rejects.toThrow("LOCATOR_AMBIGUOUS");
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

  it("retains controller reset and relaunches the pinned app without reinstalling", async () => {
    const f = fixture();
    await f.app.launch("launch");
    await f.app.reload("reload");
    await f.app.resetAppState("reset");
    expect(f.calls).toEqual([
      "/e2e/prepare-app-launch",
      "open",
      "wait-result",
      "/e2e/terminate-app",
      "/e2e/prepare-app-launch",
      "open",
      "wait-result",
      "/e2e/reset-local-app-state",
      "/e2e/prepare-app-launch",
      "open",
      "wait-result",
    ]);
    // The target's app.launchArguments ride every relaunch of the pinned app.
    expect(f.device.openApp).toHaveBeenLastCalledWith("org.example.app", {
      relaunch: true,
    });
  });

  it("holds normal launch before proxy reset until the current startup check settles", async () => {
    const f = fixture();
    const waiting = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<Record<string, unknown>>();
    f.client.waitForScreenStateField.mockImplementationOnce(() => {
      waiting.resolve();
      return settled.promise;
    });
    const run = (async () => {
      await f.app.launch("launch retry app");
      await f.app.control("reset counts", "/e2e/proxy-control", {
        reset: true,
      });
    })();
    await waiting.promise;
    expect(f.client.postJson).not.toHaveBeenCalledWith(
      "reset counts",
      "/e2e/proxy-control",
      expect.anything(),
    );
    expect(f.client.waitForScreenStateField).toHaveBeenCalledWith(
      "launch retry app: wait startup check",
      "startupCheckSettledEpoch",
      { expectedValue: "fixture-epoch" },
    );
    expect(f.screen.getByTestId).not.toHaveBeenCalled();
    expect(f.iosAlert.get).not.toHaveBeenCalled();
    settled.resolve({ startupCheckSettledEpoch: "fixture-epoch" });
    await run;
    expect(f.client.postJson).toHaveBeenLastCalledWith(
      "reset counts",
      "/e2e/proxy-control",
      { reset: true },
    );
  });

  it("preserves the existing startup epoch when Android is already focused", async () => {
    const f = fixture("android");
    f.client.postJson.mockResolvedValueOnce({
      alreadyFocused: true,
      startupCheckEpoch: "existing-runtime",
    });
    await f.app.launch("reuse Android runtime");
    expect(f.device.openApp).toHaveBeenCalledWith("org.example.app", {
      relaunch: false,
    });
    expect(f.client.waitForScreenStateField).toHaveBeenCalledWith(
      "reuse Android runtime: wait startup check",
      "startupCheckSettledEpoch",
      { expectedValue: "existing-runtime" },
    );
  });

  it("propagates a cancelled startup wait without performing a later scenario action", async () => {
    const f = fixture();
    f.client.waitForScreenStateField.mockImplementationOnce(async () => {
      f.controller.abort(new Error("cancelled startup wait"));
      throw f.controller.signal.reason;
    });
    await expect(f.app.launch("normal launch")).rejects.toThrow(
      "cancelled startup wait",
    );
    await expect(
      f.app.control("late reset", "/e2e/proxy-control", { reset: true }),
    ).rejects.toThrow("cancelled startup wait");
    expect(f.client.postJson).toHaveBeenCalledTimes(1);
  });

  it.each([{ expectCrash: true }, { allowDisconnect: true }])(
    "does not await startup or inspect UI before native recovery: %j",
    async (options) => {
      const f = fixture();
      await f.app.launch("native recovery", options);
      expect(f.client.waitForScreenStateField).not.toHaveBeenCalled();
      expect(f.screen.getByTestId).not.toHaveBeenCalled();
      expect(f.iosAlert.get).not.toHaveBeenCalled();
      await expect(
        f.app.assertText("premature", "runtime-bundle-id", "builtin"),
      ).rejects.toThrow("Native recovery must be verified");
    },
  );

  it.each(["ios", "android"] as const)(
    "waits for %s crash recovery evidence before a disconnect can lead to UI navigation",
    async (platform) => {
      const f = fixture(platform);
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
      f.locator.text = "builtin";
      await f.app.assertText("recovered", "runtime-bundle-id", "builtin");
      expect(f.device.openApp).toHaveBeenCalledTimes(1);
      expect(f.device.openLink).toHaveBeenCalledExactlyOnceWith(
        "hotupdaterexample://e2e/runtime-bundle",
        { app: "org.example.app" },
      );
    },
  );

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

  it("rethrows a launch the runner cancelled instead of awaiting recovery", async () => {
    const f = fixture();
    const cancelled = Object.assign(new Error("device.openApp cancelled"), {
      code: "CANCELLED",
    });
    f.device.openApp.mockRejectedValueOnce(cancelled);
    await expect(f.app.launch("crash", { expectCrash: true })).rejects.toBe(
      cancelled,
    );
    expect(f.app.expectedLaunchFailures).toBe(0);
    await expect(f.app.verifyConsoleInsights(0)).rejects.toThrow(
      "Native recovery evidence is missing",
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
    f.locator.matchers.toBeVisible.mockImplementationOnce(async () => {
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
