import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getLaunchConfiguration: vi.fn(),
  getLaunchInfo: vi.fn(),
  notifyAppReady: vi.fn(),
}));

vi.mock("@hot-updater/lynx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/lynx")>()),
  HotUpdater: {
    getLaunchConfiguration: native.getLaunchConfiguration,
    init: () => native,
  },
}));
vi.mock("@hot-updater/lynx-sparkling", () => ({ navigate: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  native.getLaunchInfo.mockResolvedValue({ running: { bundleId: "B" } });
  native.notifyAppReady.mockResolvedValue({ status: "CONFIRMED" });
  vi.stubGlobal("__SPIKE_VARIANT__", "B");
  vi.stubGlobal("__SPIKE_BEHAVIOR__", "normal");
  vi.stubGlobal("__SPIKE_ASSET_PREFIX__", "hot-updater:///");
  vi.stubGlobal("__SDK_RESOURCES__", true);
  vi.stubGlobal("__MATRIX_STABLE_MAIN__", "");
});

afterEach(() => vi.unstubAllGlobals());

async function startExample(example: "matrix" | "production") {
  const status = vi.fn();
  const loadFont = vi.fn().mockResolvedValue(undefined);
  const loadExternal = vi.fn().mockResolvedValue({ lazyVariant: "B" });
  const loadDynamic = vi.fn().mockResolvedValue("B");
  if (example === "matrix") {
    const sdk = await import("../spike/sdk");
    sdk.sdkImageLoaded();
    return {
      status,
      loadFont,
      loadExternal,
      loadDynamic,
      started: sdk.startSdk(
        status,
        vi.fn(),
        loadFont,
        loadExternal,
        loadDynamic,
      ),
    };
  }
  vi.stubGlobal("lynx", {
    addFont: (font: { src: string }, complete: () => void) => {
      loadFont(font.src);
      complete();
    },
    requireModuleAsync: (_url: string, complete: (error: null) => void) => {
      loadExternal();
      complete(null);
    },
    loadDynamicComponent: async () => {
      await loadDynamic();
      return { code: 0 };
    },
  });
  const sdk = await import("../spike/production-sdk");
  sdk.productionImageLoaded();
  return {
    status,
    loadFont,
    loadExternal,
    loadDynamic,
    started: sdk.startProductionSdk(status, vi.fn()),
  };
}

describe.each(["matrix", "production"] as const)(
  "%s managed fonts",
  (example) => {
    it("uses a distinct font source after runtime recreation and waits for native readiness", async () => {
      const sources: string[] = [];
      for (const runtimeGenerationEpoch of ["2", "3"]) {
        vi.resetModules();
        vi.clearAllMocks();
        native.getLaunchConfiguration.mockResolvedValue({
          appBaseURL: "https://updates.test",
          runtimeGenerationEpoch,
        });
        let confirm!: (value: unknown) => void;
        native.notifyAppReady.mockReturnValue(
          new Promise((resolve) => (confirm = resolve)),
        );
        const run = await startExample(example);
        await vi.waitFor(() =>
          expect(native.notifyAppReady).toHaveBeenCalledOnce(),
        );
        expect(run.status).not.toHaveBeenCalled();
        confirm({ status: "CONFIRMED" });
        await run.started;
        const url = `hot-updater:///assets/probe.ttf?hot-updater-generation=${runtimeGenerationEpoch}`;
        expect(run.loadFont).toHaveBeenCalledExactlyOnceWith(
          example === "production" ? `url("${url}")` : url,
        );
        expect(run.status).toHaveBeenLastCalledWith(
          expect.stringMatching(/ready/i),
        );
        sources.push(run.loadFont.mock.calls[0][0]);
      }
      expect(sources[0]).not.toBe(sources[1]);
    });

    it.each([undefined, "0", "02", "2e0"])(
      "refuses resources and readiness with epoch %s",
      async (runtimeGenerationEpoch) => {
        native.getLaunchConfiguration.mockResolvedValue({
          appBaseURL: "https://updates.test",
          runtimeGenerationEpoch,
        });
        const run = await startExample(example);
        await run.started;
        expect(run.status).toHaveBeenLastCalledWith(
          expect.stringContaining("Startup failed:"),
        );
        expect(run.loadFont).not.toHaveBeenCalled();
        expect(run.loadExternal).not.toHaveBeenCalled();
        expect(run.loadDynamic).not.toHaveBeenCalled();
        expect(native.notifyAppReady).not.toHaveBeenCalled();
      },
    );
  },
);
