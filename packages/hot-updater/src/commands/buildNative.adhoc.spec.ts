import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildIos,
  exportsForRegisteredDevices,
  log,
  markIosDevicesInBuild,
  readIpaDevices,
  registerApprovedDevices,
  registerNativeBuild,
  remember,
} = vi.hoisted(() => ({
  buildIos: vi.fn(async () => ({ logFilePath: null })),
  exportsForRegisteredDevices: vi.fn(async () => true),
  log: {
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  markIosDevicesInBuild: vi.fn(async () => {}),
  readIpaDevices: vi.fn(async (): Promise<readonly string[] | null> => []),
  registerApprovedDevices: vi.fn(),
  registerNativeBuild: vi.fn(async () => ({
    id: "0190a1b2-c3d4-7000-8000-00000000b001",
  })),
  remember: vi.fn(async () => {}),
}));

vi.mock("@hot-updater/apple-helper", () => ({
  buildIos,
  exportsForRegisteredDevices,
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log },
  withCredentialResolver: vi.fn(async (run) =>
    run({ resolve: vi.fn(), dispose: vi.fn() }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({
  getChannel: vi.fn(async () => ({ value: "production" })),
}));
let iosSchemeConfig: Record<string, unknown>;
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  // It runs the build's checks before the prebuild, as the real one does: they
  // decide whether a Debug build is tracked.
  prepareNativeBuild: vi.fn(async ({ beforePrebuild }) => {
    await beforePrebuild?.({
      scheme: "testers",
      secrets: undefined,
      iosScheme: iosSchemeConfig,
      androidScheme: undefined,
    });
    return {
      buildAdapter: { name: "bare" },
      config: { cacheDir: null },
      outputPath: "/out",
      scheme: "testers",
      target: { fingerprintHash: null, appVersion: "1.0.0" },
      iosSchemeConfig,
    };
  }),
}));
const build = {
  platform: "ios",
  scheme: "testers",
  minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
  channel: "production",
  fingerprintHash: null,
  appVersion: "1.0.0",
  artifactPath: "/out/App.ipa",
  artifactKind: "ipa",
};
// The build runs the builder, as createNativeBuild does, so the export sees
// what the registry expects.
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(
    async ({ builder }: { builder: () => Promise<unknown> }) => {
      await builder();
      return build;
    },
  ),
}));
vi.mock("../utils/native/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/sandbox")>()),
  assertBuiltArtifact: vi.fn(async () => null),
}));
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => null),
}));
vi.mock("../utils/native/reuseNativeBuild", () => ({
  reuseNativeBuild: vi.fn(async () => ({
    key: { key: null, components: null, uncacheable: "ad hoc" },
    slot: null,
    hit: null,
    report: { hit: null, key: null, uncacheable: "ad hoc", changed: [] },
    remember,
  })),
  rememberTrackedBuild: vi.fn(async () => {}),
}));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  issueMinBundleId: vi.fn(async () => "019a0000-0000-7000-8000-000000000000"),
  isNativeBuildConflict: () => false,
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild,
}));
vi.mock("../utils/native/registerApprovedDevices", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../utils/native/registerApprovedDevices")
  >()),
  registerApprovedDevices,
}));
vi.mock("../utils/native/reportIpaDevices", () => ({
  readIpaDevices,
  reportIpaDevices: vi.fn(async () => {}),
}));
vi.mock("../utils/loadServer", () => ({
  loadServer: vi.fn(async () => ({
    core: { markIosDevicesInBuild },
    dispose: vi.fn(async () => {}),
  })),
}));

import { handleNativeBuildCreate } from "./buildNative";

const PHONE = "00008030-001c2d3e4f5a6b7c";
const KIM = { id: "dev-1", udid: PHONE, name: "Kim's iPhone" };
const REPORT = {
  registered: ["Kim's iPhone"],
  waiting: 0,
  problems: [],
  missing: [],
};

describe("native-build ios of an ad hoc scheme with the device registry", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    iosSchemeConfig = {
      configuration: "Release",
      simulator: false,
      exportOptionsPlist: "/project/ExportOptions.plist",
    };
    exportsForRegisteredDevices.mockResolvedValue(true);
    registerApprovedDevices.mockResolvedValue({
      expected: [KIM],
      report: REPORT,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports with the devices the registry expects, and records them on the tracked build", async () => {
    readIpaDevices.mockResolvedValue([PHONE]);

    await handleNativeBuildCreate("ios", { scheme: "testers", json: true });

    expect(buildIos).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDevices: [PHONE] }),
    );
    expect(registerNativeBuild).toHaveBeenCalledOnce();
    expect(markIosDevicesInBuild).toHaveBeenCalledWith({
      buildId: "0190a1b2-c3d4-7000-8000-00000000b001",
      ids: ["dev-1"],
    });
    const json = JSON.parse(
      String(vi.mocked(console.log).mock.calls.at(-1)?.[0]),
    );
    expect(json.devices).toEqual(REPORT);
  });

  it("fails before tracking when the .ipa lacks a device Apple enabled, and keeps the .ipa", async () => {
    readIpaDevices.mockResolvedValue([]);

    await expect(
      handleNativeBuildCreate("ios", { scheme: "testers" }),
    ).rejects.toThrow("exit 1");

    expect(registerNativeBuild).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    expect(markIosDevicesInBuild).not.toHaveBeenCalled();
    expect(log.success).not.toHaveBeenCalled();
    const said = log.error.mock.calls.map(([line]) => String(line)).join("\n");
    expect(said).toContain(
      "The .ipa lacks 1 approved device Apple has enabled: Kim's iPhone.",
    );
    expect(said).toContain("The build stays at");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reads no registry for an App Store export, a simulator build, or a Debug build", async () => {
    exportsForRegisteredDevices.mockResolvedValue(false);
    await handleNativeBuildCreate("ios", { scheme: "testers" });

    exportsForRegisteredDevices.mockResolvedValue(true);
    iosSchemeConfig = { configuration: "Release", simulator: true };
    await handleNativeBuildCreate("ios", { scheme: "testers" });

    iosSchemeConfig = { configuration: "Debug", simulator: false };
    await handleNativeBuildCreate("ios", { scheme: "testers" });

    expect(registerApprovedDevices).not.toHaveBeenCalled();
    expect(markIosDevicesInBuild).not.toHaveBeenCalled();
    for (const [options] of buildIos.mock.calls as unknown as [
      Record<string, unknown>,
    ][]) {
      expect(options).not.toHaveProperty("expectedDevices");
    }
  });
});
