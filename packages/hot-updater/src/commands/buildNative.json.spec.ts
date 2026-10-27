import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/android-helper", () => ({ buildAndroid: vi.fn() }));
vi.mock("@hot-updater/apple-helper", () => ({ buildIos: vi.fn() }));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: {
    log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
  },
  withCredentialResolver: vi.fn(async (run) =>
    run({ resolve: vi.fn(), dispose: vi.fn() }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async () => ({
    buildAdapter: { name: "bare" },
    config: { cacheDir: null },
    outputPath: "/out",
    scheme: "simulator",
    target: { fingerprintHash: null, appVersion: "1.0.0" },
    iosSchemeConfig: { configuration: "Release" },
  })),
}));
// The artifact's version, which an xcconfig set, not the project's 1.0.0.
const build = {
  platform: "ios",
  scheme: "simulator",
  minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
  channel: "preview",
  fingerprintHash: null,
  appVersion: "2.0.0",
  artifactPath: "/out/Example.app",
  artifactKind: "app",
};
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(async () => build),
}));
const row = {
  id: "0190a1b2-c3d4-7000-8000-00000000b001",
  app_version: "2.0.0",
  artifact_kind: "app",
};
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => ({
    platform: "ios",
    channel: "production",
    fingerprintHash: "fp",
    appVersion: null,
  })),
}));
// A build no key covers: each build runs; buildNative.cache.spec.ts covers reuse.
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
  issueMinBundleId: vi.fn(async () => "019a0000-0000-7000-8000-000000000000"),
  isNativeBuildConflict: () => false,
  // The tracking preflight passes: its own specs cover it.
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild: vi.fn(async () => row),
}));

import { handleNativeBuildCreate } from "./buildNative";

const lastLine = () => vi.mocked(console.log).mock.calls.at(-1)?.[0];

describe("native-build ios|android --json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the build and its record as the last line", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "simulator",
      json: true,
    });

    expect(JSON.parse(String(lastLine()))).toEqual({
      dryRun: false,
      build,
      nativeBuild: row,
      registration: { skipped: null },
      submission: { destination: null, skipped: null, existing: null },
      cache: {
        hit: null,
        key: null,
        uncacheable: "it is a test",
        changed: [],
      },
    });
  });

  it("prints no JSON without --json", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "simulator",
    });

    expect(console.log).not.toHaveBeenCalled();
  });
});
