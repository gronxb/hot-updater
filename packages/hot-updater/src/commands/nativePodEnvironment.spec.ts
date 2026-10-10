import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  buildIos: vi.fn(async () => ({})),
  runIos: vi.fn(async () => ({})),
  runAndroid: vi.fn(async () => ({})),
  environment: vi.fn(),
  buildPlugin: vi.fn(),
}));
vi.mock("@hot-updater/apple-helper", () => ({
  buildIos: mocks.buildIos,
  runIos: mocks.runIos,
}));
vi.mock("@hot-updater/android-helper", () => ({
  buildAndroid: vi.fn(),
  runAndroid: mocks.runAndroid,
}));
vi.mock("@hot-updater/cli-tools", () => ({
  getCwd: () => "/app",
  p: { log: { info: vi.fn(), success: vi.fn(), error: vi.fn() } },
}));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: mocks.prepare,
}));
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: async ({ builder }: { builder: () => Promise<unknown> }) =>
    builder(),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("../utils/cli-ui", () => ({
  ui: {
    line: () => "native",
    platform: (value: string) => value,
    muted: (value: string) => value,
  },
}));

import { buildIosNative } from "./buildNative";
import { runAndroidNative, runIosNative } from "./runNative";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.environment.mockResolvedValue({ RCT_USE_RN_DEP: "1" });
  mocks.buildPlugin.mockResolvedValue({
    name: "selected-integration",
    nativeBuild: { getPodInstallEnvironment: mocks.environment },
  });
});

it.each([
  { configured: undefined, explicit: undefined, expected: undefined },
  { configured: 8081, explicit: undefined, expected: "8081" },
  { configured: 8081, explicit: "5060", expected: "5060" },
])(
  "uses the selected Android development port: $expected",
  async ({ configured, explicit, expected }) => {
    mocks.buildPlugin.mockResolvedValue({
      name: "selected-integration",
      nativeBuild: { developmentServerPort: configured },
    });
    mocks.prepare.mockResolvedValue({
      config: { build: mocks.buildPlugin },
      androidSchemeConfig: {},
    });
    await runAndroidNative({
      scheme: "debug",
      interactive: false,
      port: explicit,
    });
    expect(mocks.runAndroid).toHaveBeenCalledWith(
      expect.objectContaining({
        runOption: expect.objectContaining({ port: expected }),
      }),
    );
  },
);

describe.each([
  {
    name: "build",
    run: () => buildIosNative({ scheme: "release", interactive: false }),
    native: mocks.buildIos,
  },
  {
    name: "run",
    run: () => runIosNative({ scheme: "release", interactive: false }),
    native: mocks.runIos,
  },
])("$name iOS CocoaPods policy", ({ run, native }) => {
  it.each([false, true])(
    "requests integration policy only when installing pods: %s",
    async (installPods) => {
      mocks.prepare.mockResolvedValue({
        config: { build: mocks.buildPlugin },
        outputPath: "/output",
        iosSchemeConfig: { installPods },
      });
      await run();
      expect(mocks.environment).toHaveBeenCalledTimes(installPods ? 1 : 0);
      expect(native).toHaveBeenCalledWith(
        expect.objectContaining({
          podInstallEnvironment: installPods
            ? { RCT_USE_RN_DEP: "1" }
            : undefined,
        }),
      );
    },
  );

  it("runs a Lynx integration without requiring a CocoaPods policy hook", async () => {
    mocks.buildPlugin.mockResolvedValue({ name: "lynx" });
    mocks.prepare.mockResolvedValue({
      config: { build: mocks.buildPlugin },
      outputPath: "/output",
      iosSchemeConfig: { installPods: true },
    });
    await run();
    expect(mocks.environment).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({ podInstallEnvironment: undefined }),
    );
  });
});
