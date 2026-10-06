import { spawnSync } from "node:child_process";

import type { Device } from "@e2e-dev/mobile";
import type { Locator, Screen } from "e2e";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createControlClient } from "../shared/control-client.ts";
import { LynxAppDriver } from "./lynx-app-driver.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(platform: "ios" | "android" = "android") {
  const controller = new AbortController();
  const state: Record<string, unknown> = {};
  const journal = {
    nextBundleId: "candidate",
    crashedBundleIds: [] as string[],
  };
  let launchGeneration: unknown = null;
  let logMarker = "";
  let missingJournal = false;
  let iosProcesses = "";
  vi.mocked(spawnSync).mockImplementation((command, args) => {
    const argv = (args ?? []) as string[];
    if (argv.includes("HotUpdaterE2E") && argv.includes("log"))
      logMarker = argv.at(-1)!;
    return {
      status: 0,
      stdout: argv.includes("logcat")
        ? `${logMarker}\n`
        : argv.includes("get_app_container")
          ? "/container/SparklingGoE2E.app\n"
          : command === "/usr/libexec/PlistBuddy"
            ? "LynxExecutable\n"
            : command === "/bin/ps"
              ? iosProcesses
              : "",
      stderr: "",
    } as ReturnType<typeof spawnSync>;
  });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    if (url.endsWith("/e2e/prepare-app-launch"))
      launchGeneration = body.launchGeneration;
    if (url.endsWith("/e2e/screen-state")) Object.assign(state, body);
    if (url.endsWith("/e2e/lynx-crash-state") && missingJournal)
      throw new Error("Native crash journal unavailable");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify(
          url.endsWith("/e2e/lynx-crash-state")
            ? journal
            : { launchGeneration, screenState: { ...state } },
        ),
    };
  });
  const client = createControlClient({
    baseUrl: "http://control.test",
    fetch,
    signal: controller.signal,
  });
  const back = {
    isVisible: vi.fn(async () => false),
    tap: vi.fn(async () => {}),
  };
  const open = {
    tap: vi.fn(async () => {
      state.detailPageMarker = "page-A";
      state.detailPageTitle = "Second Page";
    }),
  };
  const close = {
    tap: vi.fn(async () => {
      state.detailPageMarker = "close-requested";
    }),
  };
  const visible = vi.fn(async () => {});
  const screen = {
    getByRole: vi.fn<Screen["getByRole"]>((_role, name) => {
      if (name === "Back") return back as unknown as Locator;
      if (name === "Open detail page") return open as unknown as Locator;
      if (name === "Close detail page") return close as unknown as Locator;
      throw new Error(`Unexpected button ${String(name)}`);
    }),
    getByText: vi.fn<Screen["getByText"]>(
      () => ({ waitFor: visible }) as unknown as Locator,
    ),
  };
  const device = {
    openApp: vi.fn<Device["openApp"]>(async () => {
      state.runtimeScenarioMarker = "page-A";
    }),
    closeApp: vi.fn<Device["closeApp"]>(async () => {}),
    back: vi.fn<Device["back"]>(async () => {}),
  };
  const driver = new LynxAppDriver(
    client,
    platform,
    {
      HOT_UPDATER_E2E_DEVICE_ID: "leased-device",
      HOT_UPDATER_E2E_APP_ID: "com.hotupdater.lynxexample",
      HOT_UPDATER_E2E_APP_BASE_URL:
        "http://127.0.0.1:4000/hot-updater?name=O'Brien&tenant=a",
      HOT_UPDATER_E2E_RUNTIME_CONFIG_URL:
        "http://127.0.0.1:3107/e2e/runtime-config",
    },
    {},
    { device, screen, signal: controller.signal },
  );
  return {
    driver,
    device,
    screen,
    controller,
    state,
    journal,
    fetch,
    back,
    open,
    close,
    visible,
    loseJournal: () => {
      missingJournal = true;
    },
    setIosProcesses: (value: string) => {
      iosProcesses = value;
    },
  };
}

describe("Lynx mobile SDK integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("launches with raw SDK arguments containing the current native generation", async () => {
    const f = fixture();
    await f.driver.launch("embedded launch");
    expect(f.device.openApp).toHaveBeenCalledOnce();
    const [appId, options] = f.device.openApp.mock.calls[0]!;
    expect(appId).toBe("com.hotupdater.lynxexample");
    expect(options?.relaunch).toBe(true);
    expect(options?.launchArguments?.slice(0, 2)).toEqual([
      "--es",
      "hotUpdaterLaunchConfiguration",
    ]);
    const configuration = JSON.parse(options!.launchArguments![2]!);
    const prepare = f.fetch.mock.calls.find(([url]) =>
      url.endsWith("/e2e/prepare-app-launch"),
    )!;
    expect(configuration.launchGeneration).toBe(
      JSON.parse(String(prepare[1]!.body)).launchGeneration,
    );
    expect(new URL(configuration.appBaseURL).searchParams.get("name")).toBe(
      "O'Brien",
    );
    expect(new URL(configuration.appBaseURL).searchParams.get("tenant")).toBe(
      "a",
    );
    expect(configuration.runtimeConfigURL).toBe(
      "http://127.0.0.1:3107/e2e/runtime-config",
    );
    expect(
      vi
        .mocked(spawnSync)
        .mock.calls.some(([, args]) => args?.includes("start")),
    ).toBe(false);
  });

  it("opens and closes the page through rendered buttons and retains native observation waits", async () => {
    const f = fixture();
    await f.driver.openDetailPage("open second bundle", "page-A");
    expect(f.open.tap).toHaveBeenCalledOnce();
    expect(f.screen.getByText).toHaveBeenCalledWith("Second Page");
    expect(f.screen.getByText).toHaveBeenCalledWith("page-A");
    expect(f.visible).toHaveBeenCalledTimes(2);
    await f.driver.closeDetailPage("close second bundle");
    expect(f.close.tap).toHaveBeenCalledOnce();
    expect(
      f.fetch.mock.calls.some(([url]) => url.endsWith("/e2e/pending-action")),
    ).toBe(false);
    await f.driver.nativeBack("native page back");
    expect(f.device.back).toHaveBeenCalledOnce();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fences a late navigation observation after cancellation", async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.back.isVisible.mockImplementation(() => pending.promise);
    const navigation = f.driver.openDetailPage("cancelled page open", "page-A");
    await vi.waitFor(() => expect(f.back.isVisible).toHaveBeenCalledOnce());
    const reason = new Error("attempt expired");
    f.controller.abort(reason);
    pending.resolve(true);
    await expect(navigation).rejects.toBe(reason);
    expect(f.back.tap).not.toHaveBeenCalled();
    expect(f.open.tap).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("does not run native diagnostics or recovery after a cancelled SDK launch resolves", async () => {
    const f = fixture();
    const pending = deferred<void>();
    f.device.openApp.mockImplementation(() => pending.promise);
    const launch = f.driver.launch("cancelled launch");
    await vi.waitFor(() => expect(f.device.openApp).toHaveBeenCalledOnce());
    const nativeCommands = vi.mocked(spawnSync).mock.calls.length;
    const reason = new Error("SDK attempt cancelled");
    f.controller.abort(reason);
    pending.resolve();
    await expect(launch).rejects.toBe(reason);
    expect(spawnSync).toHaveBeenCalledTimes(nativeCommands);
    expect(f.device.openApp).toHaveBeenCalledOnce();
  });

  it("requires a running iOS process even when SDK open succeeds", async () => {
    const f = fixture("ios");
    await expect(f.driver.launch("missing iOS process")).rejects.toThrow(
      "running iOS app process",
    );
    expect(f.driver.expectedLaunchFailures).toBe(0);
  });

  it("binds iOS liveness to the installed executable rather than another simulator's app", async () => {
    const f = fixture("ios");
    f.setIosProcesses(
      "77 /other-container/SparklingGoE2E.app/LynxExecutable\n" +
        "88 /container/SparklingGoE2E.app/LynxExecutable\n",
    );
    await f.driver.launch("verified iOS process");
    expect(f.device.openApp).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "spawn", "leased-device", "/bin/kill", "-0", "88"],
      expect.any(Object),
    );
  });

  it("rejects ambiguous iOS process identity", async () => {
    const f = fixture("ios");
    f.setIosProcesses(
      "77 /container/SparklingGoE2E.app/LynxExecutable\n" +
        "88 /container/SparklingGoE2E.app/LynxExecutable\n",
    );
    await expect(f.driver.launch("ambiguous process")).rejects.toThrow(
      "Multiple processes match",
    );
  });

  it("counts an expected SDK disconnect only after durable crash and recovery evidence", async () => {
    const f = fixture();
    f.device.openApp.mockImplementationOnce(async () => {
      f.journal.crashedBundleIds.push("candidate");
      throw new Error("app crashed while opening");
    });
    await f.driver.launch("candidate crash", { expectCrash: true });
    expect(f.device.openApp).toHaveBeenCalledTimes(2);
    expect(f.driver.expectedLaunchFailures).toBe(1);
  });

  it("does not accept an SDK error as proof that native crash recovery happened", async () => {
    const f = fixture();
    f.device.openApp.mockImplementationOnce(async () => {
      f.loseJournal();
      throw new Error("device unavailable");
    });
    await expect(
      f.driver.launch("unproven crash", { expectCrash: true }),
    ).rejects.toThrow("Native crash journal unavailable");
    expect(f.device.openApp).toHaveBeenCalledOnce();
    expect(f.driver.expectedLaunchFailures).toBe(0);
    await expect(f.driver.verifyConsoleInsights(0)).rejects.toThrow(
      "Native crash recovery evidence is missing",
    );
  });
});
