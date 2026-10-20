import type { CredentialResolver } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  parseVaultReference: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).parseVaultReference,
  getCwd: () => "/app",
  p: { log: { info: vi.fn(), error: vi.fn() }, outro: vi.fn() },
}));
vi.mock("./builder/buildXcodeProject", () => ({
  buildXcodeProject: vi.fn(async () => ({
    appPath: "/derived/App.app",
    infoPlistPath: "/derived/App.app/Info.plist",
  })),
}));
vi.mock("./runner/deviceRunner", () => ({
  installAndLaunchOnDevice: vi.fn(),
}));
vi.mock("./runner/simulatorRunner", () => ({
  installAndLaunchOnSimulator: vi.fn(),
}));
vi.mock("./utils/device", () => ({
  Device: { selectTargetDevice: vi.fn(), listDevices: vi.fn() },
}));

import { buildXcodeProject } from "./builder/buildXcodeProject";
import { runIos } from "./runIos";
import type { AppleDevice } from "./types";
import { Device } from "./utils/device";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";

const MIN_BUNDLE_ID = "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5";

const schemeConfig: EnrichedNativeBuildIosScheme = {
  bundleIdentifier: "com.example",
  scheme: "App",
  platform: "ios",
  installPods: false,
  configuration: "Release",
  destination: [],
  simulator: false,
  hotUpdaterSchemeName: "release",
  signing: { ascApiKey: "vault:asc-api-key" },
};

const device = (type: AppleDevice["type"]): AppleDevice => ({
  name: type,
  udid: `${type}-udid`,
  version: "18.0",
  platform: "ios",
  state: "Booted",
  type,
});

const ascKeyResolver = () => {
  const resolve = vi.fn(async () => ({
    keyPath: "/tmp/AuthKey_ABC.p8",
    keyId: "ABC",
    issuerId: "issuer",
  }));
  return { resolve: resolve as typeof resolve & CredentialResolver["resolve"] };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runIos", () => {
  it("signs a device build with the scheme's App Store Connect API key", async () => {
    vi.mocked(Device.selectTargetDevice).mockResolvedValue(device("device"));
    const credentials = ascKeyResolver();

    await runIos({
      schemeConfig,
      runOption: { interactive: false },
      minBundleId: MIN_BUNDLE_ID,
      credentials,
    });

    expect(credentials.resolve).toHaveBeenCalledWith({
      kind: "asc-api-key",
      name: "asc-api-key",
    });
    expect(buildXcodeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceType: "device",
        minBundleId: MIN_BUNDLE_ID,
        authenticationArgs: expect.arrayContaining([
          "-allowProvisioningUpdates",
          "/tmp/AuthKey_ABC.p8",
          // A device the account does not have yet is registered.
          "-allowProvisioningDeviceRegistration",
        ]),
      }),
    );
  });

  it("resolves no key for a simulator", async () => {
    vi.mocked(Device.selectTargetDevice).mockResolvedValue(device("simulator"));
    const credentials = ascKeyResolver();

    await runIos({
      schemeConfig,
      runOption: { interactive: false },
      minBundleId: MIN_BUNDLE_ID,
      credentials,
    });

    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(buildXcodeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceType: "simulator",
        authenticationArgs: undefined,
      }),
    );
  });
});
