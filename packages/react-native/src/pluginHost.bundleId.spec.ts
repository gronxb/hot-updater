import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HotUpdaterClientContext,
  HotUpdaterClientPlugin,
} from "./clientPlugin";

/**
 * The plugin context's `getBundleId()` over the real `./native`, with only the
 * native module faked: it names the same release as `hotUpdater.getBundleId()`
 * (`getUpdateId`), never the artifact the release ships.
 */
const nativeModuleMock = vi.hoisted(() => {
  Reflect.set(globalThis, "HotUpdater", { SDK_VERSION: "test-sdk-version" });
  return {
    getActiveUpdateState: vi.fn<() => unknown>(),
    getBundleId: vi.fn<() => string | null>(),
    getCohort: vi.fn(() => "123"),
    getInstallId: vi.fn(() => "install-id"),
    getStorageItem: vi.fn<(key: string) => string | null>(() => null),
    setStorageItem: vi.fn(),
    getConstants: vi.fn(() => ({
      APP_VERSION: "1.0.0",
      CHANNEL: "production",
      DEFAULT_CHANNEL: "production",
      FINGERPRINT_HASH: null,
      MIN_BUNDLE_ID: "min-bundle-id",
    })),
  };
});

vi.mock("react-native", () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} };
    }
  },
  Platform: { OS: "ios" },
}));

vi.mock("./specs/NativeHotUpdater", () => ({ default: nativeModuleMock }));

const selection = (bundleId: string, releaseId: string | null) => ({
  kind: "BUNDLE",
  bundleId,
  releaseId,
  channel: "production",
});

const contextOf = async () => {
  const { createAppPluginHost } = await import("./pluginHost");
  let context!: HotUpdaterClientContext;
  const plugin: HotUpdaterClientPlugin = {
    id: "example",
    setup: (pluginContext) => {
      context = pluginContext;
    },
  };
  createAppPluginHost().configurePlugins([plugin], {
    baseURL: "https://updates.example.com",
  });
  return context;
};

describe("client plugin context getBundleId", () => {
  beforeEach(() => {
    vi.resetModules();
    nativeModuleMock.getActiveUpdateState.mockReset();
    nativeModuleMock.getBundleId.mockReset();
  });

  it.each([
    {
      name: "a deployed release is its release ID, not its artifact's",
      active: selection("artifact-a", "release-1"),
      running: "artifact-a",
      expected: "release-1",
    },
    {
      name: "a promote that reuses the artifact is the new release",
      active: selection("artifact-a", "release-2"),
      running: "artifact-a",
      expected: "release-2",
    },
    {
      name: "a receipt without a release ID is the artifact",
      active: selection("artifact-a", null),
      running: "artifact-a",
      expected: "artifact-a",
    },
    {
      name: "the built-in bundle is MIN_BUNDLE_ID",
      active: null,
      running: null,
      expected: "min-bundle-id",
    },
    {
      name: "a staged update is named right away, as hotUpdater.getBundleId() names it",
      active: selection("artifact-b", "release-3"),
      running: "artifact-a",
      expected: "release-3",
    },
  ])("$name", async ({ active, running, expected }) => {
    nativeModuleMock.getActiveUpdateState.mockReturnValue({
      activeSelection: active,
      stableSelection: null,
      verificationPending: false,
      highestSeenCatalogs: {},
    });
    nativeModuleMock.getBundleId.mockReturnValue(running);
    const context = await contextOf();
    const { getUpdateId } = await import("./native");

    expect(context.getBundleId()).toBe(expected);
    expect(context.getBundleId()).toBe(getUpdateId());
  });
});
