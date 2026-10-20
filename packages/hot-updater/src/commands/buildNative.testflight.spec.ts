import type { EnrichedNativeBuildIosScheme } from "@hot-updater/apple-helper";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];

const ascApiKey = {
  keyPath: "/tmp/AuthKey_ABC.p8",
  keyId: "ABC",
  issuerId: "issuer",
};

vi.mock("@hot-updater/apple-helper", () => ({
  buildIos: vi.fn(),
  resolveTestFlightUploadKey: vi.fn(async () => {
    events.push("check scheme");
    return { kind: "asc-api-key", name: "asc-api-key" };
  }),
  uploadToTestFlight: vi.fn(async () => {
    events.push("upload");
    return {
      appId: "123",
      buildUploadId: "upload-1",
      state: "COMPLETE",
      testFlightUrl:
        "https://appstoreconnect.apple.com/apps/123/testflight/ios",
    };
  }),
}));
vi.mock("@hot-updater/android-helper", () => ({ buildAndroid: vi.fn() }));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log: { info: vi.fn(), success: vi.fn(), error: vi.fn() } },
  withCredentialResolver: vi.fn(async (run) =>
    run({
      resolve: vi.fn(async (request) => {
        events.push(`resolve ${request.name}`);
        return ascApiKey;
      }),
      dispose: vi.fn(),
    }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    const iosSchemeConfig = {
      configuration: "Release",
      signing: { ascApiKey: "vault:asc-api-key" },
    } as unknown as EnrichedNativeBuildIosScheme;
    await options.beforePrebuild?.({ iosSchemeConfig });
    events.push("prebuild");
    return {
      buildAdapter: { name: "bare" },
      outputPath: "/out",
      scheme: "release",
      target: { fingerprintHash: "fp", appVersion: null },
      iosSchemeConfig,
    };
  }),
}));
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(async () => {
    events.push("build");
    return {
      platform: "ios",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
      channel: "production",
      fingerprintHash: "fp",
      appVersion: null,
      artifactPath: "/out/export/App.ipa",
      artifactKind: "ipa",
    };
  }),
}));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  registerNativeBuild: vi.fn(async () => {
    events.push("register");
  }),
}));

import {
  resolveTestFlightUploadKey,
  uploadToTestFlight,
} from "@hot-updater/apple-helper";
import { p } from "@hot-updater/cli-tools";

import { createNativeBuild } from "@/utils/native/createNativeBuild";

import { buildIosNative } from "./buildNative";

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
});

describe("build:ios --upload testflight", () => {
  it("checks the scheme and resolves the key before the prebuild, then builds, registers and uploads", async () => {
    await buildIosNative({
      interactive: false,
      scheme: "release",
      register: true,
      upload: "testflight",
    });

    expect(events).toEqual([
      "check scheme",
      "resolve asc-api-key",
      "prebuild",
      "build",
      "register",
      "upload",
    ]);
    expect(uploadToTestFlight).toHaveBeenCalledWith({
      ipaPath: "/out/export/App.ipa",
      apiKey: ascApiKey,
    });
  });

  it("uploads nothing without --upload", async () => {
    await buildIosNative({ interactive: false, scheme: "release" });

    expect(events).toEqual(["prebuild", "build"]);
    expect(resolveTestFlightUploadKey).not.toHaveBeenCalled();
  });

  it("refuses a scheme TestFlight would not take before the prebuild", async () => {
    vi.mocked(resolveTestFlightUploadKey).mockRejectedValueOnce(
      new Error(
        "TestFlight takes an .ipa, and the scheme release builds a simulator .app.",
      ),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      buildIosNative({
        interactive: false,
        scheme: "release",
        upload: "testflight",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      "TestFlight takes an .ipa, and the scheme release builds a simulator .app.",
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(events).not.toContain("prebuild");
    expect(createNativeBuild).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("reports a failed upload with the path the build stays at", async () => {
    vi.mocked(uploadToTestFlight).mockRejectedValueOnce(
      new Error(
        "App Store Connect already has build 42 of version 1.2.0. Each build of a version needs a new build number (CFBundleVersion).",
      ),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      buildIosNative({
        interactive: false,
        scheme: "release",
        upload: "testflight",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      "App Store Connect already has build 42 of version 1.2.0. Each build of a version needs a new build number (CFBundleVersion).\nThe build stays at /out/export/App.ipa.",
    );
    exit.mockRestore();
  });
});
