import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One device: what native keeps across JavaScript runtimes (its key-value
 * store and runtime channel), and the clock. A reload replaces the runtime
 * but keeps the device; a new app process keeps only what native persists.
 */
const device = vi.hoisted(() => {
  Reflect.set(globalThis, "HotUpdater", { SDK_VERSION: "test-sdk-version" });
  const state = {
    store: new Map<string, string>(),
    channel: "preview",
    now: 1_000_000,
    reloads: 0,
    /** The next check fails, as offline. */
    offline: false,
    /** The app process's id, on native that names it. */
    process: 1,
  };
  const native = {
    getConstants: () => ({
      APP_VERSION: "1.0.0",
      CHANNEL: state.channel,
      DEFAULT_CHANNEL: "preview",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "00000000-0000-0000-0000-000000000000",
    }),
    getStorageItem: (key: string) => state.store.get(key) ?? null,
    setStorageItem: (key: string, value: string | null) => {
      if (value === null) state.store.delete(key);
      else state.store.set(key, value);
    },
    resetChannel: async () => {
      state.channel = "preview";
      return true;
    },
    reload: async () => {
      state.reloads += 1;
    },
    reloadProcess: async () => {
      state.reloads += 1;
    },
    addListener: () => {},
    removeListeners: () => {},
  };
  // The server: every pull request channel has a bundle for this build, so
  // a check of one installs it and switches the runtime channel to it.
  const checkForUpdate = async (options: {
    channel?: string;
    onError?: (error: Error) => void;
  }) => {
    if (state.offline) {
      state.offline = false;
      // As checkForUpdate.ts reports a failed check: onError, then null.
      options.onError?.(new Error("Network request failed"));
      return null;
    }
    return options.channel === undefined
      ? null
      : {
          status: "UPDATE",
          transitionKind: "INSTALL",
          updateBundle: async () => {
            state.channel = options.channel!;
            return true;
          },
        };
  };
  return { state, native, checkForUpdate };
});

vi.mock("react-native", () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} };
    }
  },
  Platform: { OS: "ios" },
}));
vi.mock("./specs/NativeHotUpdater", () => ({ default: device.native }));
vi.mock("./checkForUpdate", () => ({
  checkForUpdate: device.checkForUpdate,
  isChannelLeave: () => false,
  reportUpdateError: vi.fn(),
}));
vi.mock("./httpClient", () => ({ createHttpClient: () => ({}) }));
vi.mock("./pluginHost", () => ({
  createAppPluginHost: () => ({ configurePlugins: () => ({}) }),
}));
vi.mock("./appReady", () => ({
  createLaunchReporter: () => ({
    read: vi.fn(),
    appReady: Promise.resolve(),
    emit: vi.fn(),
  }),
}));
vi.mock("./nativeUpdateEvents", () => ({
  replayNativeUpdateEvents: vi.fn(),
}));

const link = (channel: string) => `myapp://hot-updater/channel/${channel}`;
const options = {
  updateStrategy: "appVersion" as const,
  defaultChannels: ["preview"],
};

/**
 * Starts a JavaScript runtime as the app does: init, then the launch URL
 * that `Linking.getInitialURL()` returns, which iOS returns again in every
 * runtime of the process.
 */
const startRuntime = async (launchURL: string | null) => {
  vi.resetModules();
  const { HotUpdater } = await import("./index");
  const hotUpdater = HotUpdater.init({ baseURL: "https://updates.example" });
  const initial =
    launchURL === null
      ? null
      : await hotUpdater.openChannelLink(launchURL, {
          ...options,
          initial: true,
        });
  return { hotUpdater, initial };
};

/** The app process ends; the next runtime starts a new one, later. */
const newProcess = () => {
  device.state.process += 1;
  device.state.now += 10 * 60_000;
};

beforeEach(() => {
  device.state.process = 1;
  device.state.store.clear();
  device.state.channel = "preview";
  device.state.reloads = 0;
  device.state.offline = false;
  device.state.now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => device.state.now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ["native from an earlier SDK", false],
  ["native that names its process", true],
])("a launch link across reloads, on %s", (_label, namesProcess) => {
  beforeEach(() => {
    if (namesProcess) {
      Reflect.set(
        device.native,
        "getProcessLaunchId",
        () => `process-${device.state.process}`,
      );
    } else {
      Reflect.deleteProperty(device.native, "getProcessLaunchId");
    }
  });

  it("keeps the channel a link opened later in the process", async () => {
    // Cold launch by the pr-2 link: it switches and reloads.
    const first = await startRuntime(link("pr-2"));
    expect(first.initial).toEqual({ status: "SWITCHED", channel: "pr-2" });
    expect(device.state.channel).toBe("pr-2");

    // The reload's runtime gets the launch link again.
    device.state.now += 1_000;
    const second = await startRuntime(link("pr-2"));
    expect(second.initial).toEqual({
      status: "ALREADY_OPENED",
      channel: "pr-2",
    });

    // The tester opens pr-1 while the app runs: it switches and reloads.
    await expect(
      second.hotUpdater.openChannelLink(link("pr-1"), options),
    ).resolves.toEqual({ status: "SWITCHED", channel: "pr-1" });
    expect(device.state.channel).toBe("pr-1");

    // That reload's runtime gets the pr-2 launch link once more.
    device.state.now += 1_000;
    const third = await startRuntime(link("pr-2"));
    expect(third.initial).toEqual({
      status: "ALREADY_OPENED",
      channel: "pr-2",
    });
    // The device stays on the channel the tester opened last.
    expect(device.state.channel).toBe("pr-1");
    expect(device.state.reloads).toBe(2);
  });

  it("opens the launch link again in a new app process", async () => {
    await startRuntime(link("pr-2"));
    device.state.now += 1_000;
    const reloaded = await startRuntime(link("pr-2"));
    await reloaded.hotUpdater.openChannelLink(link("pr-1"), options);

    // The process ends without another reload request, and later a cold
    // launch by the same link starts a new one.
    newProcess();
    const relaunched = await startRuntime(link("pr-2"));

    expect(relaunched.initial).toEqual({ status: "SWITCHED", channel: "pr-2" });
    expect(device.state.channel).toBe("pr-2");
  });

  it("treats a runtime long after an unanswered reload request as a new process", async () => {
    const first = await startRuntime(link("pr-2"));
    expect(first.initial).toMatchObject({ status: "SWITCHED" });
    await first.hotUpdater.openChannelLink(link("pr-1"), options);

    // The reload request is never answered: the process dies, and a cold
    // launch by the pr-2 link comes much later.
    newProcess();
    const relaunched = await startRuntime(link("pr-2"));

    expect(relaunched.initial).toEqual({ status: "SWITCHED", channel: "pr-2" });
  });

  it("opens a link the app gets while running even when it is the launch link", async () => {
    await startRuntime(link("pr-2"));
    device.state.now += 1_000;
    const reloaded = await startRuntime(link("pr-2"));
    await reloaded.hotUpdater.openChannelLink(link("pr-1"), options);
    device.state.now += 1_000;
    const again = await startRuntime(link("pr-2"));

    // The tester scans the pr-2 code again.
    await expect(
      again.hotUpdater.openChannelLink(link("pr-2"), options),
    ).resolves.toEqual({ status: "SWITCHED", channel: "pr-2" });
    expect(device.state.channel).toBe("pr-2");
  });

  it("opens a launch link again after its opening failed", async () => {
    // Switched to pr-1 earlier in this process; then a launch by pr-2 fails
    // offline after leaving pr-1, so the app reloads to the built-in bundle.
    device.state.channel = "pr-1";
    device.state.offline = true;
    const failed = await startRuntime(null);
    await expect(
      failed.hotUpdater.openChannelLink(link("pr-2"), {
        ...options,
        initial: true,
      }),
    ).rejects.toThrow("Network request failed");
    expect(device.state.reloads).toBe(1);

    // The reload's runtime gets the launch link again, and now opens it.
    device.state.now += 1_000;
    const retried = await startRuntime(link("pr-2"));

    expect(retried.initial).toEqual({ status: "SWITCHED", channel: "pr-2" });
    expect(device.state.channel).toBe("pr-2");
  });

  it.runIf(namesProcess)(
    "opens the launch link in a new process right after an unanswered reload",
    async () => {
      const first = await startRuntime(link("pr-2"));
      expect(first.initial).toMatchObject({ status: "SWITCHED" });
      await first.hotUpdater.openChannelLink(link("pr-1"), options);

      // The OS ends the app before the reload's runtime starts, and the
      // tester launches it by the pr-2 link a second later.
      device.state.process += 1;
      device.state.now += 1_000;
      const relaunched = await startRuntime(link("pr-2"));

      expect(relaunched.initial).toEqual({
        status: "SWITCHED",
        channel: "pr-2",
      });
    },
  );
});
