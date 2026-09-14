import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createControlClient } from "../detox/control-client.ts";
import { LynxAppDriver } from "./lynx-app-driver.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

function createDriver(readScreenState: () => Record<string, unknown>) {
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ screenState: readScreenState() }),
  }));
  const client = createControlClient({
    baseUrl: "http://control.test",
    fetch,
  });
  return { driver: new LynxAppDriver(client, "ios", {}), fetch };
}

function mockAndroidCommands(logsSinceLaunch: string | (() => string) = "") {
  let launchLogMarker = "";
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    if (args.includes("HotUpdaterE2E")) {
      launchLogMarker = String(args.at(-1));
    }
    return {
      status: 0,
      stdout: args.includes("pidof")
        ? "456\n"
        : args.includes("-d")
          ? `${launchLogMarker}\n${typeof logsSinceLaunch === "function" ? logsSinceLaunch() : logsSinceLaunch}`
          : "",
      stderr: "",
    } as ReturnType<typeof spawnSync>;
  });
}

describe("Lynx app text assertions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([false, true])(
    "rejects unsupported IDs instead of passing silently (exact=%s)",
    async (exactText) => {
      const { driver, fetch } = createDriver(() => ({
        updateActionResult: "expected text",
      }));
      await expect(
        driver.assertText("unknown field", "unknown-test-id", "expected text", {
          exactText,
        }),
      ).rejects.toThrow("Unsupported Lynx text assertion: unknown-test-id");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not infer an empty crash history from unrelated UUIDs", async () => {
    const { driver } = createDriver(() => {
      vi.setSystemTime(60_000);
      return {
        currentBundleId: "00000000-0000-7000-8000-000000000000",
        updateActionResult: "current-channel -> installed ID release-0",
      };
    });
    await expect(
      driver.assertText("empty crash history", "crash-history-count", "0"),
    ).rejects.toThrow("crash-history-count (crashHistoryCount)");
  });

  it("requires the real crash count for an exact assertion", async () => {
    const { driver } = createDriver(() => {
      vi.setSystemTime(60_000);
      return {
        crashHistoryCount: "0",
        updateActionResult: "recorded 10 crashes",
      };
    });
    await expect(
      driver.assertText("loaded crash history", "crash-history-count", "10", {
        exactText: true,
      }),
    ).rejects.toThrow('received "0"');
  });

  it.each([
    ["runtime-bundle-id", "currentBundleId", "stagingBundleId", "bundle-B"],
    [
      "runtime-release-state",
      "currentReleaseId",
      "stagingReleaseId",
      "release-B",
    ],
    ["runtime-current-cohort", "currentCohort", "cohortInput", "qa"],
  ])(
    "does not satisfy %s from staged state or an action result",
    async (testID, field, unrelatedField, expected) => {
      const { driver } = createDriver(() => {
        vi.setSystemTime(60_000);
        return {
          [field]: null,
          [unrelatedField]: expected,
          updateActionResult: `installed ${expected}`,
        };
      });
      await expect(
        driver.assertText("current runtime", testID, expected),
      ).rejects.toThrow(`${testID} (${field})`);
    },
  );

  it.each([
    ["runtime-bundle-id", "currentBundleId", "bundle-A"],
    ["runtime-release-state", "currentReleaseId", "release-A"],
    ["runtime-current-cohort", "currentCohort", "qa"],
    ["crash-history-count", "crashHistoryCount", "10"],
  ])(
    "accepts the actual published %s value",
    async (testID, field, expected) => {
      const { driver } = createDriver(() => ({ [field]: expected }));
      await expect(
        driver.assertText("current runtime", testID, expected, {
          exactText: true,
        }),
      ).resolves.toBeUndefined();
    },
  );

  it("waits for the field itself and honors exact text", async () => {
    let currentReleaseId: string | null = null;
    const { driver, fetch } = createDriver(() => ({
      currentReleaseId,
      updateActionResult: "installed release-A",
    }));
    let complete = false;
    const assertion = driver
      .assertText("running release", "runtime-release-state", "release-A", {
        exactText: true,
      })
      .then(() => {
        complete = true;
      });
    await vi.advanceTimersByTimeAsync(250);
    expect(complete).toBe(false);
    currentReleaseId = "release-A-extra";
    await vi.advanceTimersByTimeAsync(250);
    expect(complete).toBe(false);
    currentReleaseId = "release-A";
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(complete).toBe(true);
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("Lynx managed page evidence actions", () => {
  it("captures the package-owned runtime journal through the real page action", async () => {
    const snapshot = {
      schemaVersion: 1,
      oldestSequence: "1",
      latestSequence: "1",
      truncated: false,
      events: [
        {
          sequence: "1",
          name: "pageAdmitted",
          details: {
            runtimeId: "runtime-b",
            processId: "123",
            generationId: "generation-b",
            bundleId: "bundle-b",
            releaseId: "release-b",
            contextId: "detail-b",
            pageAttemptId: "page-attempt-b",
            transitionId: null,
          },
        },
      ],
    };
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.endsWith("/e2e/screen-state") ||
            url.endsWith("/e2e/runtime-config")
            ? {
                screenState: {
                  generationEvents: JSON.stringify(snapshot),
                  updateActionResult: "generation-events -> 1",
                },
              }
            : {},
        ),
    }));
    const driver = new LynxAppDriver(
      createControlClient({ baseUrl: "http://control.test", fetch }),
      "ios",
      {},
    );

    await expect(driver.captureGenerationEvents("capture")).resolves.toEqual(
      snapshot,
    );
    const requests = fetch.mock.calls.map(([, init]) =>
      init?.body ? JSON.parse(String(init.body)) : null,
    );
    expect(requests).toContainEqual({
      testID: "action-capture-generation-events",
    });
  });

  it("uses the platform-native back operation for a managed detail page", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<
      typeof spawnSync
    >);
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch: vi.fn(),
    });
    const android = new LynxAppDriver(client, "android", {
      HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554",
    });

    await android.nativeBack("native back");

    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "adb",
      ["-s", "emulator-5554", "shell", "input", "keyevent", "BACK"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });
});

describe("Lynx app installation", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("boots an iOS simulator before installing the shared native binary", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<
      typeof spawnSync
    >);
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch: vi.fn(),
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    driver.ensureInstalled();

    expect(vi.mocked(spawnSync).mock.calls.slice(0, 2)).toEqual([
      [
        "xcrun",
        ["simctl", "bootstatus", "iPhone 17 Pro", "-b"],
        expect.objectContaining({ encoding: "utf8" }),
      ],
      [
        "xcrun",
        ["simctl", "install", "iPhone 17 Pro", "/tmp/SparklingGo.app"],
        expect.objectContaining({ encoding: "utf8" }),
      ],
    ]);
  });

  it("does not install when the iOS simulator fails to boot", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stderr: "boot failed",
    } as ReturnType<typeof spawnSync>);
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch: vi.fn(),
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    expect(() => driver.ensureInstalled()).toThrow("boot failed");
    expect(vi.mocked(spawnSync)).toHaveBeenCalledOnce();
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "bootstatus", "iPhone 17 Pro", "-b"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("preserves Android launch configuration JSON through adb shell", async () => {
    mockAndroidCommands();
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.endsWith("/e2e/runtime-config")
            ? { screenState: { runtimeScenarioMarker: "ready" } }
            : {},
        ),
    }));
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
    });
    const driver = new LynxAppDriver(client, "android", {
      HOT_UPDATER_CONTROL_BASE_URL: "http://127.0.0.1:3008/hot-updater",
      HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554",
    });

    await driver.launch("initial launch");

    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        "emulator-5554",
        "shell",
        "am",
        "start",
        "-S",
        "-n",
        "com.hotupdater.lynxexample/.OtaActivity",
        "--es",
        "hotUpdaterLaunchConfiguration",
        expect.stringMatching(
          /^'\{"appBaseURL":"http:\/\/127\.0\.0\.1:3008\/hot-updater","launchGeneration":"[0-9a-f-]+","runtimeConfigURL":"http:\/\/localhost:3107\/e2e\/runtime-config"\}'$/,
        ),
      ],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it.each([301, 302])(
    "fails an Android launch with managed-resource engine code %s after native confirmation",
    async (code) => {
      mockAndroidCommands(
        [
          "HotUpdaterLynx: confirmed bundle=bundle-A release=null attempt=attempt-A",
          `HotUpdaterLynx: engine-error fatal=false code=${code} message=resource failed`,
        ].join("\n"),
      );
      const fetch = vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith("/e2e/runtime-config")
              ? { screenState: { runtimeScenarioMarker: "bundle-A-marker" } }
              : {},
          ),
      }));
      const client = createControlClient({
        baseUrl: "http://control.test",
        fetch,
      });
      const driver = new LynxAppDriver(client, "android", {
        HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554",
      });

      await expect(driver.launch("confirmed launch")).rejects.toThrow(
        `Managed Lynx resources emitted engine errors: ${code}`,
      );
    },
  );

  it("checks managed-resource errors before an allow-disconnect launch returns", async () => {
    mockAndroidCommands(
      [
        "HotUpdaterLynx: engine-error fatal=false code=301 message=image failed",
        ...Array.from({ length: 600 }, (_, index) => `later log ${index}`),
      ].join("\n"),
    );
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch: vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            url.endsWith("/e2e/runtime-config")
              ? { screenState: { runtimeScenarioMarker: "ready" } }
              : {},
          ),
      })),
    });
    const driver = new LynxAppDriver(client, "android", {
      HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554",
    });

    await expect(
      driver.launch("force-update launch", { allowDisconnect: true }),
    ).rejects.toThrow("Managed Lynx resources emitted engine errors: 301");
  });

  it("checks the replacement process after a delayed automatic restart", async () => {
    let replacementLogs = "initial process clean";
    mockAndroidCommands(() => replacementLogs);
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => {
        if (url.endsWith("/e2e/runtime-config")) {
          return JSON.stringify({
            screenState: { runtimeScenarioMarker: "initial-marker" },
          });
        }
        if (url.includes("/e2e/jobs/restart-job")) {
          return JSON.stringify({ status: "succeeded", result: {} });
        }
        if (url.endsWith("/e2e/jobs/wait-for-android-restart")) {
          return JSON.stringify({ jobId: "restart-job" });
        }
        return "{}";
      },
    }));
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
    });
    const driver = new LynxAppDriver(client, "android", {
      HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554",
    });

    await driver.launch("force-update launch", { allowDisconnect: true });
    replacementLogs = [
      "replacement process started",
      "HotUpdaterLynx: confirmed bundle=bundle-B release=release-B attempt=attempt-B",
      "HotUpdaterLynx: engine-error fatal=false code=301 message=replacement image failed",
    ].join("\n");

    await expect(
      driver.control(
        "prove automatic restart",
        "/e2e/jobs/wait-for-android-restart",
        { bundleId: "bundle-B" },
      ),
    ).rejects.toThrow("Managed Lynx resources emitted engine errors: 301");
  });
});

describe("Lynx startup failure diagnostics", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("adds failed screen state and bounded iOS native output to a marker timeout", async () => {
    let screenStatePosts = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/e2e/runtime-config")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ screenState: {} }),
        };
      }
      if (url.endsWith("/e2e/screen-state")) {
        screenStatePosts += 1;
        const body =
          screenStatePosts === 1
            ? {}
            : { screenState: { launchStatus: "ERROR startup failed" } };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
        };
      }
      expect(init?.method).toBe("POST");
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
      };
    });
    vi.mocked(spawnSync).mockImplementation(
      (_command, args) =>
        ({
          status: 0,
          stdout: args.includes("log") ? "native bootstrap error" : "123 R app",
          stderr: "",
        }) as ReturnType<typeof spawnSync>,
    );
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
      screenStateTimeoutMs: 0,
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    await expect(driver.launch("initial launch")).rejects.toThrow(
      /timed out waiting for runtimeScenarioMarker[\s\S]*ERROR startup failed[\s\S]*native bootstrap error/,
    );
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "xcrun",
      [
        "simctl",
        "spawn",
        "iPhone 17 Pro",
        "log",
        "show",
        "--last",
        "2m",
        "--style",
        "compact",
        "--predicate",
        expect.stringMatching(
          /process == "SparklingGo".*messageType == error.*eventMessage CONTAINS\[c\] "hot-updater".*eventMessage CONTAINS "FirstScreen".*eventMessage CONTAINS "onPageChanged".*eventMessage CONTAINS "NativeModule" AND eventMessage CONTAINS "HotUpdaterLynx"/,
        ),
      ],
      expect.objectContaining({ maxBuffer: 512 * 1024, timeout: 5000 }),
    );
  });

  it("reports native diagnostic command buffer failures", async () => {
    let screenStatePosts = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/e2e/runtime-config")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ screenState: {} }),
        };
      }
      if (url.endsWith("/e2e/screen-state")) screenStatePosts += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(screenStatePosts > 1 ? { screenState: {} } : {}),
      };
    });
    vi.mocked(spawnSync).mockImplementation(
      (_command, args) =>
        ({
          status: args.includes("log") ? null : 0,
          stdout: "",
          stderr: "",
          ...(args.includes("log")
            ? { error: new Error("spawnSync ENOBUFS") }
            : {}),
        }) as ReturnType<typeof spawnSync>,
    );
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
      screenStateTimeoutMs: 0,
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    await expect(driver.launch("initial launch")).rejects.toThrow(
      /timed out waiting for runtimeScenarioMarker[\s\S]*ios-unified-log \(status null\):[\s\S]*spawnSync ENOBUFS/,
    );
  });

  it("captures Android logs from the explicit launch marker", async () => {
    let screenStatePosts = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/e2e/runtime-config")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ screenState: {} }),
        };
      }
      if (url.endsWith("/e2e/screen-state")) screenStatePosts += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            screenStatePosts > 1
              ? { screenState: { launchStatus: "ERROR Android startup" } }
              : {},
          ),
      };
    });
    mockAndroidCommands("android bootstrap error");
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
      screenStateTimeoutMs: 0,
    });
    const driver = new LynxAppDriver(client, "android", {
      HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554",
    });

    await expect(driver.launch("initial launch")).rejects.toThrow(
      /timed out waiting for runtimeScenarioMarker[\s\S]*ERROR Android startup[\s\S]*android bootstrap error/,
    );
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "adb",
      ["-s", "emulator-5554", "logcat", "-d"],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it("does not mask the marker timeout when diagnostics also fail", async () => {
    let screenStatePosts = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/e2e/runtime-config")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ screenState: {} }),
        };
      }
      if (url.endsWith("/e2e/screen-state")) {
        screenStatePosts += 1;
        if (screenStatePosts > 1) throw new Error("diagnostic server failed");
      }
      return {
        ok: true,
        status: 200,
        text: async () => "{}",
      };
    });
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      if (args.includes("spawn")) throw new Error("simctl unavailable");
      return { status: 0, stdout: "", stderr: "" } as ReturnType<
        typeof spawnSync
      >;
    });
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
      screenStateTimeoutMs: 0,
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    await expect(driver.launch("initial launch")).rejects.toThrow(
      /timed out waiting for runtimeScenarioMarker[\s\S]*screen-state unavailable: Error: diagnostic server failed[\s\S]*ios-processes unavailable: Error: simctl unavailable/,
    );
  });
});
