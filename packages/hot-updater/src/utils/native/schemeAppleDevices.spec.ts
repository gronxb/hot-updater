import fs from "fs";
import os from "os";
import path from "path";

import { secret } from "@hot-updater/cli-tools";
import type { NativeBuildRow, StorageAdapter } from "@hot-updater/plugin-core";
import { readIpaInstallInfo } from "@hot-updater/protocol/native-artifact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readIosDeviceCoverage } from "./iosDeviceCoverage";
import { readSchemeAppleDevices } from "./schemeAppleDevices";

const { listAscDevices } = vi.hoisted(() => ({ listAscDevices: vi.fn() }));
vi.mock("@hot-updater/apple-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/apple-helper")>()),
  listAscDevices,
}));
// The scheme's App Store Connect key resolves, as in a job that has it.
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  readLoadedHotUpdaterEnv: vi.fn(async () => ({})),
  withCredentialResolver: vi.fn(
    async (run: (credentials: unknown) => unknown) =>
      run({
        resolve: async () => ({
          issuerId: "issuer-a",
          keyId: "KEY",
          keyPath: "/dev/null",
        }),
      }),
  ),
}));
vi.mock("@hot-updater/protocol/native-artifact", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@hot-updater/protocol/native-artifact")
  >()),
  readIpaInstallInfo: vi.fn(),
}));
vi.mock("./downloadNativeBuild", () => ({
  resolveNativeBuildDownloadUrl: vi.fn(async () => null),
  downloadNativeBuild: vi.fn(async (_storage, _build, file: string) => {
    fs.writeFileSync(file, "ipa!");
    return { byteSize: 4 };
  }),
}));

const config = (ios: Record<string, unknown>) =>
  ({ nativeBuild: { ios: { adhoc: ios }, android: {} } }) as never;

let directory: string | undefined;
afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("readSchemeAppleDevices", () => {
  it("says a scheme without signing.ascApiKey can't add a device, and asks Apple nothing", async () => {
    await expect(
      readSchemeAppleDevices(
        config({ bundleIdentifier: "com.example" }),
        "adhoc",
      ),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "the scheme signs without signing.ascApiKey",
    });
    expect(listAscDevices).not.toHaveBeenCalled();
  });

  it("says a scheme that pins a profile can't add a device, and asks Apple nothing", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "apple-devices-"));
    const plist = path.join(directory, "ExportOptions.plist");
    fs.writeFileSync(
      plist,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>release-testing</string><key>signingStyle</key><string>manual</string></dict></plist>',
    );
    await expect(
      readSchemeAppleDevices(
        config({
          bundleIdentifier: "com.example",
          exportOptionsPlist: plist,
          signing: { ascApiKey: "secret:asc-api-key" },
        }),
        "adhoc",
      ),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "the scheme pins a provisioning profile",
    });
    expect(listAscDevices).not.toHaveBeenCalled();
  });
});

describe("a scheme whose build adds no registry devices", () => {
  it("never asks for a build for a device a development export can't get, on any check", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "apple-devices-"));
    const plist = path.join(directory, "ExportOptions.plist");
    fs.writeFileSync(
      plist,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>method</key><string>debugging</string><key>signingStyle</key><string>automatic</string></dict></plist>',
    );
    const development = config({
      bundleIdentifier: "com.example",
      exportOptionsPlist: plist,
      signing: { ascApiKey: secret("asc-api-key") },
    });
    listAscDevices.mockResolvedValue([]);
    vi.mocked(readIpaInstallInfo).mockResolvedValue({
      bundleId: "com.example",
      bundleVersion: "1",
      title: "Example",
      distribution: "development",
      devices: [],
      expiresAtMs: null,
    } as never);
    const core = {
      listIosDevices: vi.fn(async ({ status }: { status?: string }) =>
        status === "approved"
          ? [
              {
                id: "device-b",
                udid: "b",
                name: "Bo's iPad",
                status: "approved",
                approved_at_ms: 1,
                registered_at_ms: null,
                apple_issuer_id: null,
                apple_error: null,
              },
            ]
          : [],
      ),
      findIosDeviceAccount: vi.fn(async () => null),
    };
    const build = {
      id: "build-1",
      artifact_kind: "ipa",
      export_method: "development",
      artifact_storage_uri: "storage://native-builds/ios/build-1/App.ipa",
      byte_size: 4,
    } as NativeBuildRow;

    for (let run = 0; run < 2; run += 1) {
      await expect(
        readIosDeviceCoverage(
          { core: core as never, storage: {} as StorageAdapter },
          build,
          () => readSchemeAppleDevices(development, "adhoc"),
        ),
      ).resolves.toEqual({
        reusable: true,
        reason: null,
        missing: [],
        waiting: [
          {
            name: "Bo's iPad",
            reason: "the scheme doesn't export with release-testing",
          },
        ],
      });
    }
    expect(listAscDevices).not.toHaveBeenCalled();
  });
});
