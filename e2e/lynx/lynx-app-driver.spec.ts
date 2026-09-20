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

function mockAndroidCommands(
  logsSinceLaunch: string | (() => string) = "",
  runtimeJournal = "",
  processId: string | (() => string) = "456\n",
) {
  let launchLogMarker = "";
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    if (args.includes("HotUpdaterE2E")) {
      launchLogMarker = String(args.at(-1));
    }
    return {
      status: 0,
      stdout: args.includes("pidof")
        ? typeof processId === "function"
          ? processId()
          : processId
        : args.includes("run-as")
          ? runtimeJournal
          : args.includes("-d")
            ? `${launchLogMarker}\n${typeof logsSinceLaunch === "function" ? logsSinceLaunch() : logsSinceLaunch}`
            : "",
      stderr: "",
    } as ReturnType<typeof spawnSync>;
  });
}

const ANDROID_302_DIAGNOSTIC = String.raw`09-14 20:30:41.275  456  7719 I HotUpdaterLynx: engine-error fatal=false code=302 message={"error_code":302,"sub_code":30201,"error":"Src format is incorrect","src":"hot-updater:\/\/\/assets\/probe.ttf","type":"font"}`;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function androidJournalFixture() {
  const identity = {
    attemptId: "attempt-A",
    bundleId: "bundle-A",
    contextId: "context-A",
    generationId: "generation-A",
    pageAttemptId: null,
    processId: "456",
    releaseId: "release-A",
    runtimeId: "runtime-A",
    transitionId: null,
  };
  const events = [
    { details: { ...identity, primary: true }, name: "generationWillEvaluate" },
    { details: identity, name: "generationStarted" },
    {
      details: {
        ...identity,
        code: 302,
        fatal: false,
        path: "assets/probe.ttf",
        subcode: 30201,
        type: "font",
      },
      name: "engineDiagnostic",
    },
    {
      details: {
        ...identity,
        path: "assets/probe.ttf",
        sha256: "a".repeat(64),
      },
      name: "fontLoaded",
    },
    {
      details: { ...identity, confirmation: { status: "CONFIRMED" } },
      name: "jsReady",
    },
  ].map((event, index) => ({ ...event, sequence: String(index + 1) }));
  return {
    events,
    journal: canonical({
      events,
      nextSequence: "6",
      schemaVersion: 1,
      truncated: false,
    }),
    snapshot: JSON.stringify({
      events,
      latestSequence: "5",
      oldestSequence: "1",
      schemaVersion: 1,
      truncated: false,
    }),
  };
}

function androidJournalFetch(
  snapshot: string,
  options: {
    readonly evidenceDelayPolls?: number;
    readonly initialActionResult?: string;
  } = {},
) {
  const latestSequence = String(
    (JSON.parse(snapshot) as { latestSequence: unknown }).latestSequence,
  );
  let launchGeneration: string | null = null;
  let evidenceRequested = false;
  let evidencePolls = 0;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    if (url.endsWith("/e2e/prepare-app-launch")) {
      launchGeneration = String(body.launchGeneration);
    }
    if (
      url.endsWith("/e2e/pending-action") &&
      body.testID === "action-capture-generation-events"
    ) {
      evidenceRequested = true;
    }
    const evidenceReady =
      evidenceRequested &&
      (!url.endsWith("/e2e/runtime-config") ||
        evidencePolls++ >= (options.evidenceDelayPolls ?? 0));
    const screenState = {
      currentBundleId: "bundle-A",
      currentReleaseId: "release-A",
      generationEvents: evidenceReady ? snapshot : null,
      launchStatus: "Current Launch Status: UNCHANGED",
      runtimeScenarioMarker: "bundle-A-marker",
      updateActionResult: evidenceReady
        ? `generation-events -> ${latestSequence}`
        : (options.initialActionResult ?? "idle"),
    };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.endsWith("/e2e/runtime-config")
            ? { screenState }
            : url.endsWith("/e2e/screen-state") &&
                Object.keys(body).length === 0
              ? { launchGeneration, screenState }
              : {},
        ),
    };
  });
}

type AndroidJournalAcquisitionFailure =
  | "reset"
  | "request"
  | "receipt"
  | "read";

function failingAndroidJournalFetch(
  snapshot: string,
  failure: AndroidJournalAcquisitionFailure,
  thrownValue: unknown,
) {
  const fetch = androidJournalFetch(snapshot);
  let evidenceRequested = false;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const isReset =
      url.endsWith("/e2e/screen-state") && body.generationEvents === null;
    const isRequest =
      url.endsWith("/e2e/pending-action") &&
      body.testID === "action-capture-generation-events";
    const isReceipt = evidenceRequested && url.endsWith("/e2e/runtime-config");
    const isRead =
      evidenceRequested &&
      url.endsWith("/e2e/screen-state") &&
      Object.keys(body).length === 0;
    if (
      (failure === "reset" && isReset) ||
      (failure === "request" && isRequest) ||
      (failure === "receipt" && isReceipt) ||
      (failure === "read" && isRead)
    ) {
      throw thrownValue;
    }
    if (isRequest) evidenceRequested = true;
    return fetch(url, init);
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
  it("waits for the detail page close request before returning", async () => {
    let screenReads = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          screenState: {
            detailPageMarker:
              init?.method === "POST" || screenReads++ === 0
                ? "E2E_SCENARIO_MARKER"
                : "close-requested",
          },
        }),
    }));
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
      pollDelayMs: async () => undefined,
    });
    const driver = new LynxAppDriver(client, "ios", {});

    await driver.closeDetailPage("close detail");

    expect(screenReads).toBe(2);
    expect(fetch.mock.calls[0]).toEqual([
      "http://control.test/e2e/pending-action",
      expect.objectContaining({
        body: JSON.stringify({ testID: "action-close-detail-page" }),
        method: "POST",
      }),
    ]);
  });

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

  it("resolves an iOS simulator name before using agent-device", async () => {
    vi.mocked(spawnSync).mockImplementation(
      (command, args) =>
        ({
          status: 0,
          stdout:
            command === "xcrun" && args.includes("devices")
              ? JSON.stringify({
                  devices: {
                    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
                      {
                        name: "iPhone 17 Pro",
                        state: "Booted",
                        udid: "10AB9405-035A-4243-8D85-154B641AA009",
                      },
                    ],
                  },
                })
              : "",
        }) as ReturnType<typeof spawnSync>,
    );
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch: vi.fn(),
    });
    const ios = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    await ios.nativeBack("native back");

    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "agent-device",
      expect.arrayContaining([
        "--udid",
        "10AB9405-035A-4243-8D85-154B641AA009",
      ]),
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("steals a leftover agent-device session during iOS native back", async () => {
    let openCount = 0;
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      const argv = args as string[];
      if (command === "xcrun") {
        return {
          status: 0,
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
                {
                  name: "iPhone 17 Pro",
                  state: "Booted",
                  udid: "10AB9405-035A-4243-8D85-154B641AA009",
                },
              ],
            },
          }),
        } as ReturnType<typeof spawnSync>;
      }
      if (command === "agent-device" && argv[0] === "open") {
        openCount += 1;
        if (openCount === 1) {
          return {
            status: 1,
            stdout: JSON.stringify({
              success: false,
              error: {
                code: "DEVICE_IN_USE",
                message:
                  'Device is already in use by session "lynx-e2e-1082".',
              },
            }),
          } as ReturnType<typeof spawnSync>;
        }
      }
      return {
        status: 0,
        stdout: JSON.stringify({ success: true, data: { sessions: [] } }),
      } as ReturnType<typeof spawnSync>;
    });
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch: vi.fn(),
    });
    const ios = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    await ios.nativeBack("native back");

    expect(openCount).toBe(2);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "agent-device",
      ["close", "--session", "lynx-e2e-1082", "--json"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });
});

describe("Lynx update actions", () => {
  it("rejects an update action error by default", async () => {
    const { driver } = createDriver(() => ({
      updateActionResult: "current-channel -> error download failed",
    }));

    await expect(
      driver.tap("install update", "action-install-current-channel-update"),
    ).rejects.toThrow(
      'install update: wait updateActionResult observed failed updateActionResult: "current-channel -> error download failed"',
    );
  });

  it("allows an intentional update failure to be asserted by the scenario", async () => {
    const { driver } = createDriver(() => ({
      updateActionResult: "current-channel -> error download failed",
    }));

    await expect(
      driver.tap("install update", "action-install-current-channel-update", {
        allowErrorResult: true,
      }),
    ).resolves.toBeUndefined();
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
          /^'\{"appBaseURL":"http:\/\/127\.0\.0\.1:3008\/hot-updater","channel":"production","launchGeneration":"[0-9a-f-]+","runtimeConfigURL":"http:\/\/127\.0\.0\.1:3107\/e2e\/runtime-config"\}'$/,
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

  it.each([
    [
      "log.envelope",
      ANDROID_302_DIAGNOSTIC.replace(
        /^09-14 .*? I HotUpdaterLynx: /,
        "HotUpdaterLynx: ",
      ),
    ],
    [
      "log.current-process-id",
      ANDROID_302_DIAGNOSTIC.replace("  456  7719 ", "  999  7719 "),
    ],
    ["log.payload-shape", `${ANDROID_302_DIAGNOSTIC} trailing`],
    ["log.fatal", ANDROID_302_DIAGNOSTIC.replace("fatal=false", "fatal=true")],
    [
      "log.engine-error-count",
      ANDROID_302_DIAGNOSTIC.replace(
        "Src format is incorrect",
        "nested engine-error",
      ),
    ],
    [
      "log.details-json",
      ANDROID_302_DIAGNOSTIC.replace(/message=\{.*\}$/, "message={bad}"),
    ],
    [
      "log.details-error-code",
      ANDROID_302_DIAGNOSTIC.replace('"error_code":302', '"error_code":301'),
    ],
    [
      "log.details-subcode",
      ANDROID_302_DIAGNOSTIC.replace('"sub_code":30201', '"sub_code":30202'),
    ],
    [
      "log.details-type",
      ANDROID_302_DIAGNOSTIC.replace('"type":"font"', '"type":"image"'),
    ],
    [
      "log.managed-source",
      ANDROID_302_DIAGNOSTIC.replace("hot-updater:", "https:"),
    ],
    [
      "log.eligible-diagnostic-count",
      `${ANDROID_302_DIAGNOSTIC}\n${ANDROID_302_DIAGNOSTIC}`,
    ],
  ])(
    "reports the exact Android 302 pre-eligibility gate %s",
    async (reason, diagnostic) => {
      mockAndroidCommands(diagnostic);
      const driver = new LynxAppDriver(
        createControlClient({
          baseUrl: "http://control.test",
          fetch: vi.fn(async (url: string) => ({
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify(
                url.endsWith("/e2e/runtime-config")
                  ? {
                      screenState: {
                        runtimeScenarioMarker: "bundle-A-marker",
                      },
                    }
                  : {},
              ),
          })),
        }),
        "android",
        { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
      );

      await expect(driver.launch(`pre-gate ${reason}`)).rejects.toThrow(
        `Android journal recovery: reason=${reason}`,
      );
    },
  );

  it("reports an unavailable PID before evaluating a raw Android 302", async () => {
    const privateDiagnostic = `private-initial-pid-${"x".repeat(4096)}`;
    mockAndroidCommands(ANDROID_302_DIAGNOSTIC, "", `${privateDiagnostic}\n`);
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch: vi.fn(async (url: string) => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              url.endsWith("/e2e/runtime-config")
                ? {
                    screenState: {
                      runtimeScenarioMarker: "bundle-A-marker",
                    },
                  }
                : {},
            ),
        })),
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    const rejection = await driver.launch("invalid PID").then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(
      "Android journal recovery: reason=log.current-process-id-unavailable",
    );
    expect((rejection as Error).message).not.toContain(privateDiagnostic);
    expect((rejection as Error).message.length).toBeLessThan(256);
  });

  it("reports code 301 blocking recovery when the logs also contain 302", async () => {
    mockAndroidCommands(
      `${ANDROID_302_DIAGNOSTIC}\nHotUpdaterLynx: engine-error code=301`,
    );
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch: vi.fn(async (url: string) => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              url.endsWith("/e2e/runtime-config")
                ? {
                    screenState: {
                      runtimeScenarioMarker: "bundle-A-marker",
                    },
                  }
                : {},
            ),
        })),
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    await expect(driver.launch("mixed resource failures")).rejects.toThrow(
      "Android journal recovery: reason=log.code-301-present",
    );
  });

  it("reads screen identity and the durable journal for a real Android 302", async () => {
    const fixture = androidJournalFixture();
    const diagnostic = String.raw`09-14 20:30:41.275  456  7719 I HotUpdaterLynx: engine-error fatal=false code=302 message={"error_code":302,"sub_code":30201,"error":"Src format is incorrect","src":"hot-updater:\/\/\/assets\/probe.ttf","type":"font"}`;
    mockAndroidCommands(diagnostic, fixture.journal);
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch: androidJournalFetch(fixture.snapshot),
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    await expect(driver.launch("journal recovery")).resolves.toBeUndefined();
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        "emulator-5554",
        "shell",
        "run-as",
        "com.hotupdater.lynxexample",
        "cat",
        "files/hot-updater-lynx/runtime-events/events.json",
      ],
      expect.objectContaining({ maxBuffer: 20 * 1024 * 1024 }),
    );
  });

  it("waits for the Android generation snapshot instead of accepting a stale action receipt", async () => {
    const fixture = androidJournalFixture();
    mockAndroidCommands(ANDROID_302_DIAGNOSTIC, fixture.journal);
    const fetch = androidJournalFetch(fixture.snapshot, {
      evidenceDelayPolls: 1,
      initialActionResult: "current-channel -> installed ID stale-release",
    });
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch,
        pollDelayMs: async () => undefined,
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    await expect(
      driver.launch("journal receipt race"),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["reset", "screen.reset-request-unavailable"],
    ["request", "screen.evidence-request-unavailable"],
    ["receipt", "screen.evidence-receipt-unavailable"],
    ["read", "screen.evidence-read-unavailable"],
  ] as const)(
    "reports and redacts an Android journal %s acquisition failure",
    async (failure, reason) => {
      const fixture = androidJournalFixture();
      const privateDiagnostic = `private-${failure}-${"x".repeat(4096)}`;
      mockAndroidCommands(ANDROID_302_DIAGNOSTIC, fixture.journal);
      const driver = new LynxAppDriver(
        createControlClient({
          baseUrl: "http://control.test",
          fetch: failingAndroidJournalFetch(
            fixture.snapshot,
            failure,
            privateDiagnostic,
          ),
        }),
        "android",
        { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
      );

      const rejection = await driver.launch(`journal ${failure} failure`).then(
        () => null,
        (error: unknown) => error,
      );

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain(
        `Android journal recovery: reason=${reason}`,
      );
      expect((rejection as Error).message).not.toContain(privateDiagnostic);
      expect((rejection as Error).message.length).toBeLessThan(256);
    },
  );

  it("rejects a recovered eligible 302 with the exact extra-candidate gate", async () => {
    const fixture = androidJournalFixture();
    const malformedDiagnostic = ANDROID_302_DIAGNOSTIC.replace(
      /^09-14 .*? I HotUpdaterLynx: /,
      "HotUpdaterLynx: ",
    );
    mockAndroidCommands(
      `${ANDROID_302_DIAGNOSTIC}\n${malformedDiagnostic}`,
      fixture.journal,
    );
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch: androidJournalFetch(fixture.snapshot),
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    const rejection = await driver
      .launch("mixed eligible and malformed diagnostics")
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(
      "Android journal recovery: reason=log.envelope",
    );
    expect((rejection as Error).message).not.toContain(
      "reason=log.unmatched-engine-error",
    );
  });

  it("reports the exact redacted Android journal rejection gate", async () => {
    const fixture = androidJournalFixture();
    const snapshot = JSON.parse(fixture.snapshot) as {
      events: Array<{ details: Record<string, unknown> }>;
    };
    snapshot.events[0].details.primary = false;
    const diagnostic = String.raw`09-14 20:30:41.275  456  7719 I HotUpdaterLynx: engine-error fatal=false code=302 message={"error_code":302,"sub_code":30201,"error":"Src format is incorrect","src":"hot-updater:\/\/\/assets\/probe.ttf","type":"font"}`;
    mockAndroidCommands(diagnostic, fixture.journal);
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch: androidJournalFetch(JSON.stringify(snapshot)),
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    await expect(driver.launch("journal rejection")).rejects.toThrow(
      /Managed Lynx resources emitted engine errors: 302; Android journal recovery: reason=evidence\.canonical-events-mismatch .*action=\{type=object keys=\[updateActionResult\] keyCount=1 receipt=generation-events:5\} .*journal=\{bytes=.+ events=5 first=1 last=5 next=6 truncated=false\}/,
    );
  });

  it("fails closed when run-as cannot read the Android runtime journal", async () => {
    const fixture = androidJournalFixture();
    const diagnostic = String.raw`09-14 20:30:41.275  456  7719 I HotUpdaterLynx: engine-error fatal=false code=302 message={"error_code":302,"sub_code":30201,"error":"Src format is incorrect","src":"hot-updater:\/\/\/assets\/probe.ttf","type":"font"}`;
    mockAndroidCommands(diagnostic);
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch: androidJournalFetch(fixture.snapshot),
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    await expect(driver.launch("missing journal")).rejects.toThrow(
      "Android journal recovery: reason=journal.read-unavailable",
    );
  });

  it("reports a process change before accepting Android journal evidence", async () => {
    const fixture = androidJournalFixture();
    const processIds = ["456\n", "789\n"];
    mockAndroidCommands(
      ANDROID_302_DIAGNOSTIC,
      fixture.journal,
      () => processIds.shift() ?? "789\n",
    );
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch: androidJournalFetch(fixture.snapshot),
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    await expect(driver.launch("process changed")).rejects.toThrow(
      "Android journal recovery: reason=screen.current-process-id-changed",
    );
  });

  it("reports and redacts an unavailable PID after journal capture", async () => {
    const fixture = androidJournalFixture();
    const privateDiagnostic = `private-pid-${"x".repeat(4096)}`;
    const processIds = ["456\n", `${privateDiagnostic}\n`];
    mockAndroidCommands(
      ANDROID_302_DIAGNOSTIC,
      fixture.journal,
      () => processIds.shift() ?? `${privateDiagnostic}\n`,
    );
    const driver = new LynxAppDriver(
      createControlClient({
        baseUrl: "http://control.test",
        fetch: androidJournalFetch(fixture.snapshot),
      }),
      "android",
      { HOT_UPDATER_E2E_ANDROID_SERIAL: "emulator-5554" },
    );

    const rejection = await driver.launch("post-capture PID unavailable").then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain(
      "Android journal recovery: reason=screen.current-process-id-unavailable",
    );
    expect((rejection as Error).message).not.toContain(privateDiagnostic);
    expect((rejection as Error).message.length).toBeLessThan(256);
  });

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

  it("rejects a successful iOS launch that does not report a process ID", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
    }));
    vi.mocked(spawnSync).mockImplementation((_command, args) =>
      args?.includes("launch")
        ? ({
            status: 0,
            stdout: "unexpected simctl output\n",
            stderr: "",
          } as ReturnType<typeof spawnSync>)
        : ({ status: 0, stdout: "", stderr: "" } as ReturnType<
            typeof spawnSync
          >),
    );
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    await expect(driver.launch("initial launch")).rejects.toThrow(
      'xcrun simctl launch succeeded without a process ID: "unexpected simctl output\\n"',
    );
    expect(fetch).not.toHaveBeenCalledWith(
      "http://control.test/e2e/runtime-config",
      expect.anything(),
    );
  });

  it("allows an expected crash launch to omit a process ID", async () => {
    vi.useFakeTimers();
    try {
      let launches = 0;
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
      vi.mocked(spawnSync).mockImplementation((_command, args) => {
        if (args?.includes("launch")) {
          launches += 1;
          return {
            status: 0,
            stdout: launches === 1 ? "" : "com.hotupdater.lynxexample: 4321\n",
            stderr: "",
          } as ReturnType<typeof spawnSync>;
        }
        return { status: 0, stdout: "", stderr: "" } as ReturnType<
          typeof spawnSync
        >;
      });
      const client = createControlClient({
        baseUrl: "http://control.test",
        fetch,
      });
      const driver = new LynxAppDriver(client, "ios", {
        HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
        HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
      });

      const launch = driver.launch("expected crash launch", {
        expectCrash: true,
      });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(launch).resolves.toBeUndefined();
      expect(launches).toBe(2);
      expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
        "xcrun",
        ["simctl", "spawn", "iPhone 17 Pro", "/bin/kill", "-0", "4321"],
        expect.objectContaining({ timeout: 5000 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails immediately with native evidence when the launched iOS process dies", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
    }));
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      if (args?.includes("launch")) {
        return {
          status: 0,
          stdout: "com.hotupdater.lynxexample: 4321\n",
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      if (args?.includes("/bin/kill")) {
        return {
          status: 1,
          stdout: "",
          stderr: "kill: 4321: No such process",
        } as ReturnType<typeof spawnSync>;
      }
      return {
        status: 0,
        stdout: args?.includes("log") ? "fatal descriptor startup failure" : "",
        stderr: "",
      } as ReturnType<typeof spawnSync>;
    });
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
      screenStateTimeoutMs: 60_000,
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    await expect(driver.launch("initial launch")).rejects.toThrow(
      /iOS app process 4321 exited while waiting for runtimeScenarioMarker[\s\S]*No such process[\s\S]*fatal descriptor startup failure/,
    );
    expect(fetch).not.toHaveBeenCalledWith(
      "http://control.test/e2e/runtime-config",
      expect.anything(),
    );
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "spawn", "iPhone 17 Pro", "/bin/kill", "-0", "4321"],
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      "xcrun",
      [
        "simctl",
        "spawn",
        "iPhone 17 Pro",
        "/bin/ps",
        "-axo",
        "pid=,state=,command=",
      ],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it("detects an iOS process that dies after the first marker poll", async () => {
    let processProbes = 0;
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.endsWith("/e2e/runtime-config") ? { screenState: {} } : {},
        ),
    }));
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      if (args?.includes("launch")) {
        return {
          status: 0,
          stdout: "com.hotupdater.lynxexample: 4321\n",
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      if (args?.includes("/bin/kill")) {
        processProbes += 1;
        return {
          status: processProbes === 1 ? 0 : 1,
          stdout: "",
          stderr: processProbes === 1 ? "" : "kill: 4321: No such process",
        } as ReturnType<typeof spawnSync>;
      }
      return { status: 0, stdout: "", stderr: "" } as ReturnType<
        typeof spawnSync
      >;
    });
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
      pollDelayMs: async () => {},
      screenStateTimeoutMs: 60_000,
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    await expect(driver.launch("initial launch")).rejects.toThrow(
      /iOS app process 4321 exited while waiting for runtimeScenarioMarker[\s\S]*No such process/,
    );
    expect(processProbes).toBe(2);
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).endsWith("/e2e/runtime-config"),
      ),
    ).toHaveLength(1);
  });

  it("reports an unavailable iOS process probe as an inspection failure", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
    }));
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      if (args?.includes("launch")) {
        return {
          status: 0,
          stdout: "com.hotupdater.lynxexample: 4321\n",
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      if (args?.includes("/bin/kill")) {
        return {
          error: new Error("spawnSync ENOENT"),
          status: null,
          stdout: "",
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      return { status: 0, stdout: "", stderr: "" } as ReturnType<
        typeof spawnSync
      >;
    });
    const client = createControlClient({
      baseUrl: "http://control.test",
      fetch,
      screenStateTimeoutMs: 60_000,
    });
    const driver = new LynxAppDriver(client, "ios", {
      HOT_UPDATER_E2E_IOS_BINARY_PATH: "/tmp/SparklingGo.app",
      HOT_UPDATER_E2E_IOS_SIMULATOR_NAME: "iPhone 17 Pro",
    });

    const launch = driver.launch("initial launch");
    await expect(launch).rejects.toThrow(
      /Could not inspect iOS app process 4321 while waiting for runtimeScenarioMarker[\s\S]*spawnSync ENOENT/,
    );
    await expect(launch).rejects.not.toThrow(
      "exited while waiting for runtimeScenarioMarker",
    );
    expect(fetch).not.toHaveBeenCalledWith(
      "http://control.test/e2e/runtime-config",
      expect.anything(),
    );
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
          stdout: args.includes("launch")
            ? "com.hotupdater.lynxexample: 4321\n"
            : args.includes("log")
              ? "native bootstrap error"
              : "123 R app",
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
          stdout: args.includes("launch")
            ? "com.hotupdater.lynxexample: 4321\n"
            : "",
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

  it("captures Android launch logs without clearing install evidence", async () => {
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
      [
        "-s",
        "emulator-5554",
        "logcat",
        "-d",
        "HotUpdaterE2E:I",
        "HotUpdaterLynx:D",
        "AndroidRuntime:E",
        "*:S",
      ],
      expect.objectContaining({ timeout: 15000 }),
    );
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalledWith(
      "adb",
      ["-s", "emulator-5554", "logcat", "-c"],
      expect.anything(),
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
      if (args.includes("launch")) {
        return {
          status: 0,
          stdout: "com.hotupdater.lynxexample: 4321\n",
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      if (args.includes("/bin/kill")) {
        return { status: 0, stdout: "", stderr: "" } as ReturnType<
          typeof spawnSync
        >;
      }
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
