import { DatabaseConstraintError } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The configuration of the scheme the config sets, per test. */
let configuration = "Release";

vi.mock("@hot-updater/android-helper", () => ({ buildAndroid: vi.fn() }));
vi.mock("@hot-updater/apple-helper", () => ({ buildIos: vi.fn() }));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: {
    log: {
      info: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      message: vi.fn(),
    },
  },
  loadConfig: vi.fn(async () => ({})),
  withCredentialResolver: vi.fn(async (run) =>
    run({ resolve: vi.fn(), dispose: vi.fn() }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    const iosScheme = { configuration, simulator: true };
    await options.beforePrebuild?.({ scheme: "simulator", iosScheme });
    return {
      buildAdapter: { name: "bare" },
      config: { cacheDir: null },
      outputPath: "/out",
      scheme: "simulator",
      target: { fingerprintHash: null, appVersion: "1.0.0" },
      iosSchemeConfig: iosScheme,
    };
  }),
}));
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(async ({ minBundleId }) => ({
    platform: "ios",
    scheme: "simulator",
    minBundleId,
    channel: "production",
    fingerprintHash: null,
    appVersion: "1.0.0",
    artifactPath: "/out/Example.app",
    artifactKind: "app",
  })),
}));
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => null),
}));
vi.mock("../utils/native/reuseNativeBuild", () => ({
  reuseNativeBuild: vi.fn(async () => ({
    key: { key: null, components: null, uncacheable: "it is a test" },
    slot: null,
    hit: null,
    report: { hit: null, key: null, uncacheable: "it is a test", changed: [] },
    remember: vi.fn(async () => {}),
  })),
  rememberTrackedBuild: vi.fn(async () => {}),
}));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  // registerNativeBuild.spec.ts covers the check against core's refusal.
  isNativeBuildConflict: (error: unknown) =>
    error instanceof Error && error.message === "native_builds: exists",
  issueMinBundleId: vi.fn(async () => "019a0b1c-2d3f-7000-8000-000000000000"),
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild: vi.fn(async () => ({ id: "row" })),
}));

import { p } from "@hot-updater/cli-tools";

import { createNativeBuild } from "@/utils/native/createNativeBuild";
import {
  issueMinBundleId,
  registerNativeBuild,
} from "@/utils/native/registerNativeBuild";

import { handleNativeBuildCreate } from "./buildNative";

const mockExit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);

const builtWith = () =>
  vi.mocked(createNativeBuild).mock.calls[0]![0].minBundleId;

describe("native-build ios|android MIN_BUNDLE_ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configuration = "Release";
  });

  it("builds a tracked build with the MIN_BUNDLE_ID issued past the registry's bundles", async () => {
    await handleNativeBuildCreate("ios", { scheme: "simulator" });

    expect(issueMinBundleId).toHaveBeenCalledTimes(1);
    expect(builtWith()).toBe("019a0b1c-2d3f-7000-8000-000000000000");
    expect(registerNativeBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        minBundleId: "019a0b1c-2d3f-7000-8000-000000000000",
      }),
      { buildKey: null },
    );
  });

  it("issues a dry run's MIN_BUNDLE_ID past the registry's bundles too, as its cached build may be tracked later", async () => {
    await handleNativeBuildCreate("ios", { scheme: "simulator", dryRun: true });

    expect(issueMinBundleId).toHaveBeenCalledTimes(1);
    expect(registerNativeBuild).not.toHaveBeenCalled();
  });

  it("reads no registry for a Debug build, which is never tracked, and gives it zero random bits", async () => {
    configuration = "Debug";

    await handleNativeBuildCreate("ios", { scheme: "simulator" });

    expect(issueMinBundleId).not.toHaveBeenCalled();
    expect(builtWith()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/,
    );
  });

  it("builds nothing when the registry can't be read for the MIN_BUNDLE_ID", async () => {
    vi.mocked(issueMinBundleId).mockRejectedValueOnce(
      new Error("database unreachable"),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("ios", { scheme: "simulator" }),
    ).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(createNativeBuild).not.toHaveBeenCalled();
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "can't reach its native build registry: database unreachable\nNothing was built.",
      ),
    );
    exit.mockRestore();
  });

  it("says another build registered its built-in bundle first when the registry refuses its MIN_BUNDLE_ID", async () => {
    vi.mocked(registerNativeBuild).mockRejectedValueOnce(
      new DatabaseConstraintError("exists", "native_builds"),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("ios", { scheme: "simulator" }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      "Tracking the native build failed: another native build registered its built-in bundle 019a0b1c-2d3f-7000-8000-000000000000 first, as a build that started in the same millisecond does. Build it again: the build issues a new MIN_BUNDLE_ID.\nThe build stays at /out/Example.app.",
    );
    exit.mockRestore();
  });
});
