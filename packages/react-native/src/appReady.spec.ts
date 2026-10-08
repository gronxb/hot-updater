import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNotifyReadResult, stubNotifyFrame } from "./appReady.test-utils";
import type {
  AppReadyResult,
  HotUpdaterClientHooks,
  HotUpdaterClientPlugin,
} from "./clientPlugin";
import type {
  ActiveUpdateState,
  LaunchTransition,
  NotifyAppReadyResult,
} from "./native";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

const mocks = vi.hoisted(() => {
  Reflect.set(globalThis, "HotUpdater", { SDK_VERSION: "test-sdk-version" });
  return {
    getAppVersion: vi.fn(() => "1.0.0"),
    getBundleId: vi.fn(() => "bundle-id"),
    getChannel: vi.fn(() => "production"),
    getActiveUpdateState: vi.fn<() => ActiveUpdateState>(),
    getCohort: vi.fn(() => "123"),
    getFingerprintHash: vi.fn(() => "fingerprint-hash"),
    getInstallId: vi.fn(() => "install-id"),
    getStorageItem: vi.fn<(key: string) => string | null>(() => null),
    setStorageItem: vi.fn(),
    readNotifyAppReady: vi.fn<
      () => {
        transition: LaunchTransition | null;
        pending: boolean;
        result: NotifyAppReadyResult;
      }
    >(() => createNotifyReadResult()),
  };
});

vi.mock("./native", () => mocks);

const recordingPlugin = (
  hooks: (events: unknown[]) => HotUpdaterClientHooks = (events) => ({
    onAppReady: (result) => {
      events.push(["onAppReady", result]);
    },
    onBundleDownloaded: (info) => {
      events.push(["onBundleDownloaded", info]);
    },
  }),
) => {
  const events: unknown[] = [];
  const plugin: HotUpdaterClientPlugin = {
    id: "recorder",
    setup: () => ({ hooks: hooks(events) }),
  };
  return { events, plugin };
};

/** An instance's plugin host with `plugins`, and the launch reporter on it. */
const configure = async (
  plugins: HotUpdaterClientPlugin[],
  onError?: (error: unknown) => void,
) => {
  const { createAppPluginHost } = await import("./pluginHost");
  const { createLaunchReporter } = await import("./appReady");
  const host = createAppPluginHost();
  host.configurePlugins(plugins, {
    baseURL: "https://updates.example.com",
    ...(onError ? { onError } : {}),
  });
  return createLaunchReporter(host);
};

describe("app-ready reporting to plugins", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getAppVersion.mockReturnValue("1.0.0");
    mocks.getBundleId.mockReturnValue("bundle-id");
    mocks.getChannel.mockReturnValue("production");
    mocks.getActiveUpdateState.mockReturnValue({
      activeSelection: null,
      stableSelection: null,
      verificationPending: false,
    });
    mocks.getCohort.mockReturnValue("123");
    mocks.getFingerprintHash.mockReturnValue("fingerprint-hash");
    mocks.getInstallId.mockReturnValue("install-id");
    mocks.getStorageItem.mockReturnValue(null);
    mocks.readNotifyAppReady.mockReturnValue(createNotifyReadResult());
  });

  it.each([
    {
      label: "running selection",
      pending: false,
      channel: "production",
      expected: "release-running",
    },
    {
      label: "staged selection",
      pending: true,
      channel: "production",
      expected: "release-running",
    },
    {
      label: "another channel",
      pending: false,
      channel: "preview",
      expected: null,
    },
  ])(
    "attributes an unchanged launch with $label",
    async ({ pending, channel, expected }) => {
      stubNotifyFrame();
      const running = {
        kind: "BUNDLE" as const,
        releaseId: "release-running",
        bundleId: "bundle-id",
        channel,
      };
      mocks.getActiveUpdateState.mockReturnValue({
        activeSelection: pending
          ? {
              ...running,
              releaseId: "release-pending",
              bundleId: "bundle-pending",
            }
          : running,
        stableSelection: pending ? running : null,
        verificationPending: pending,
      });
      const { events, plugin } = recordingPlugin();
      const launch = await configure([plugin]);

      const readiness = launch.read({});
      await vi.runOnlyPendingTimersAsync();
      await readiness;

      expect(events).toEqual([
        [
          "onAppReady",
          {
            status: "UNCHANGED",
            channel: "production",
            bundleId: "bundle-id",
            releaseId: expected,
          } satisfies AppReadyResult,
        ],
      ]);
    },
  );

  it.each(["UPDATE_APPLIED", "RECOVERED"] as const)(
    "reports %s with the persisted transition and calls onNotifyAppReady",
    async (status) => {
      stubNotifyFrame();
      mocks.readNotifyAppReady.mockReturnValue(
        createNotifyReadResult(
          { status, fromBundleId: "bundle-a", toBundleId: "bundle-b" },
          {
            type: status,
            fromBundleId: "bundle-a",
            fromReleaseId: "release-a",
            toBundleId: "bundle-b",
            toReleaseId: "release-b",
            updateStrategy: "fingerprint",
          },
        ),
      );
      const { events, plugin } = recordingPlugin();
      const launch = await configure([plugin]);
      const onNotifyAppReady = vi.fn();

      const readiness = launch.read({ onNotifyAppReady });
      await vi.runOnlyPendingTimersAsync();
      await readiness;

      expect(events).toEqual([
        [
          "onAppReady",
          {
            status,
            channel: "production",
            fromBundleId: "bundle-a",
            fromReleaseId: "release-a",
            toBundleId: "bundle-b",
            toReleaseId: "release-b",
            updateStrategy: "fingerprint",
          },
        ],
      ]);
      expect(onNotifyAppReady).toHaveBeenCalledWith({
        status,
        fromBundleId: "bundle-a",
        toBundleId: "bundle-b",
      });
    },
  );

  it("waits for native launch verification before reporting", async () => {
    stubNotifyFrame();
    mocks.readNotifyAppReady
      .mockReturnValueOnce(createNotifyReadResult(undefined, null, true))
      .mockReturnValueOnce(createNotifyReadResult(undefined, null, true))
      .mockReturnValue(createNotifyReadResult());
    const { events, plugin } = recordingPlugin();
    const launch = await configure([plugin]);

    const readiness = launch.read({});
    await vi.runOnlyPendingTimersAsync();
    expect(events).toEqual([]);
    await vi.runAllTimersAsync();
    await readiness;

    expect(mocks.readNotifyAppReady).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(1);
  });

  it("reports the launch once to each instance's plugins", async () => {
    stubNotifyFrame();
    const first = recordingPlugin();
    const second = recordingPlugin();
    const firstLaunch = await configure([first.plugin]);
    const secondLaunch = await configure([second.plugin]);
    const onNotifyAppReady = vi.fn();

    const reads = [
      firstLaunch.read({ onNotifyAppReady }),
      firstLaunch.read({ onNotifyAppReady }),
      secondLaunch.read({ onNotifyAppReady }),
    ];
    await vi.runOnlyPendingTimersAsync();
    await Promise.all(reads);

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(onNotifyAppReady).toHaveBeenCalledTimes(2);
  });

  it("skips onAppReady for an applied launch without its persisted transition", async () => {
    stubNotifyFrame();
    mocks.readNotifyAppReady.mockReturnValue(
      createNotifyReadResult(
        {
          status: "UPDATE_APPLIED",
          fromBundleId: "bundle-a",
          toBundleId: "bundle-b",
        },
        null,
      ),
    );
    const { events, plugin } = recordingPlugin();
    const launch = await configure([plugin]);
    const onNotifyAppReady = vi.fn();

    const readiness = launch.read({ onNotifyAppReady });
    await vi.runOnlyPendingTimersAsync();
    await readiness;

    expect(events).toEqual([]);
    expect(onNotifyAppReady).toHaveBeenCalledOnce();
  });

  it("reports a throwing or rejecting hook through onError and keeps readiness", async () => {
    stubNotifyFrame();
    const onError = vi.fn();
    const throwing: HotUpdaterClientPlugin = {
      id: "throwing",
      setup: () => ({
        hooks: {
          onAppReady: () => {
            throw new Error("hook failed");
          },
        },
      }),
    };
    const rejecting: HotUpdaterClientPlugin = {
      id: "rejecting",
      setup: () => ({
        hooks: {
          onAppReady: async () => {
            throw new Error("hook rejected");
          },
        },
      }),
    };
    const launch = await configure([throwing, rejecting], onError);
    const onNotifyAppReady = vi.fn();

    const readiness = launch.read({ onNotifyAppReady });
    await vi.runOnlyPendingTimersAsync();
    await readiness;
    await vi.runAllTimersAsync();

    expect(onNotifyAppReady).toHaveBeenCalledWith({ status: "UNCHANGED" });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[HotUpdater] Plugin "throwing" failed in onAppReady',
        cause: expect.objectContaining({ message: "hook failed" }),
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[HotUpdater] Plugin "rejecting" failed in onAppReady',
      }),
    );
  });

  it("delivers events after the launch, even when they happen first", async () => {
    stubNotifyFrame();
    const { events, plugin } = recordingPlugin();
    const launch = await configure([plugin]);

    const readiness = launch.read({});
    launch.emit("onBundleDownloaded", () => ({
      channel: "production",
      fromBundleId: "bundle-id",
      fromReleaseId: null,
      toBundleId: "next-bundle",
      toReleaseId: "next-release",
      updateStrategy: "appVersion",
      delivery: "manifest",
      patchFallback: false,
    }));
    expect(events).toEqual([]);
    await vi.runOnlyPendingTimersAsync();
    await readiness;
    await Promise.resolve();

    expect(events.map((event) => (event as [string])[0])).toEqual([
      "onAppReady",
      "onBundleDownloaded",
    ]);
  });

  it("builds no event when no plugin listens", async () => {
    stubNotifyFrame();
    const launch = await configure([]);

    const readiness = launch.read({});
    await vi.runOnlyPendingTimersAsync();
    await readiness;

    expect(mocks.getActiveUpdateState).not.toHaveBeenCalled();
    expect(mocks.getBundleId).not.toHaveBeenCalled();
  });
});
