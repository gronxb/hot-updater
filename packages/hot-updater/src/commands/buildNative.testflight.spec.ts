import type { EnrichedNativeBuildIosScheme } from "@hot-updater/apple-helper";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
/** The scheme the config sets, as beforePrebuild receives it. */
let iosScheme: Record<string, unknown> = { configuration: "Release" };

const ascApiKey = {
  keyPath: "/tmp/AuthKey_ABC.p8",
  keyId: "ABC",
  issuerId: "issuer",
};

vi.mock("@hot-updater/apple-helper", () => ({
  assertTestFlightExportOptions: vi.fn(async () => {
    events.push("check export options");
  }),
  buildIos: vi.fn(),
  resolveTestFlightUploadKey: vi.fn(() => {
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
vi.mock("../utils/native/ascApiKey", () => ({
  ensureAscApiKey: vi.fn(async ({ name }: { name: string }) => {
    events.push(`ensure ${name}`);
    return { status: "stored" };
  }),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log: { info: vi.fn(), success: vi.fn(), error: vi.fn() } },
  withCredentialResolver: vi.fn(async (run) => {
    try {
      return await run({
        resolve: vi.fn(async (request) => {
          events.push(`resolve ${request.name}`);
          return ascApiKey;
        }),
        dispose: vi.fn(),
      });
    } finally {
      events.push("dispose");
    }
  }),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    const iosSchemeConfig = {
      configuration: "Release",
      signing: { ascApiKey: "secret:asc-api-key" },
    } as unknown as EnrichedNativeBuildIosScheme;
    await options.beforePrebuild?.({ scheme: "release", iosScheme });
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

import { ensureAscApiKey } from "../utils/native/ascApiKey";
import { CredentialSetupRefusedError } from "../utils/native/issuedCredential";
import { buildIosNative } from "./buildNative";

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  iosScheme = { configuration: "Release", bundleIdentifier: "com.example.app" };
});

const mockExit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => {
    events.push("exit");
    throw new Error("exit");
  }) as never);

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
      "ensure asc-api-key",
      "resolve asc-api-key",
      "prebuild",
      "check export options",
      "build",
      "register",
      "upload",
      "dispose",
    ]);
    expect(uploadToTestFlight).toHaveBeenCalledWith({
      ipaPath: "/out/export/App.ipa",
      apiKey: ascApiKey,
    });
  });

  it("uploads nothing without --upload", async () => {
    await buildIosNative({ interactive: false, scheme: "release" });

    expect(events).toEqual(["prebuild", "build", "dispose"]);
    expect(resolveTestFlightUploadKey).not.toHaveBeenCalled();
  });

  it("refuses a scheme TestFlight would not take before the prebuild", async () => {
    vi.mocked(resolveTestFlightUploadKey).mockImplementationOnce(() => {
      throw new Error(
        "TestFlight takes an .ipa, and the scheme release builds a simulator .app.",
      );
    });
    const exit = mockExit();

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
    const exit = mockExit();

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
    // The resolver deletes its temporary files before the process exits.
    expect(events.slice(-2)).toEqual(["dispose", "exit"]);
    exit.mockRestore();
  });
});

describe("build:ios without an App Store Connect API key", () => {
  it("issues the key before the prebuild", async () => {
    await buildIosNative({
      interactive: false,
      scheme: "release",
      upload: "testflight",
    });
    expect(ensureAscApiKey).toHaveBeenCalledWith({ name: "asc-api-key" });
    expect(events.indexOf("ensure asc-api-key")).toBeLessThan(
      events.indexOf("prebuild"),
    );
  });

  it("builds nothing when there is no terminal to sign in in, and logs nothing more", async () => {
    vi.mocked(ensureAscApiKey).mockImplementationOnce(async () => {
      throw new CredentialSetupRefusedError("no terminal");
    });
    const exit = mockExit();

    await expect(
      buildIosNative({
        interactive: false,
        scheme: "release",
        upload: "testflight",
      }),
    ).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    // canPrompt already logged the refusal with the command to run.
    expect(p.log.error).not.toHaveBeenCalled();
    expect(events).not.toContain("prebuild");
    expect(events).not.toContain("resolve asc-api-key");
    exit.mockRestore();
  });

  it("reports a key that could not be issued, before the prebuild", async () => {
    vi.mocked(ensureAscApiKey).mockRejectedValueOnce(
      new Error("The env secrets adapter is read-only."),
    );
    const exit = mockExit();
    await expect(
      buildIosNative({
        interactive: false,
        scheme: "release",
        upload: "testflight",
      }),
    ).rejects.toThrow("exit");
    expect(p.log.error).toHaveBeenCalledWith(
      "The env secrets adapter is read-only.",
    );
    expect(events).not.toContain("prebuild");
    exit.mockRestore();
  });

  it("issues the key a device build signs with, by the name signing.ascApiKey sets", async () => {
    iosScheme = {
      configuration: "Release",
      bundleIdentifier: "com.example.widget",
      signing: { ascApiKey: "secret:widget-asc" },
    };
    await buildIosNative({ interactive: false, scheme: "release" });
    expect(ensureAscApiKey).toHaveBeenCalledWith({ name: "widget-asc" });
    // The signing key resolves before the prebuild, with the build's others.
    expect(events).toEqual([
      "ensure widget-asc",
      "resolve widget-asc",
      "prebuild",
      "build",
      "dispose",
    ]);
  });

  it.each([
    [
      "a simulator build",
      { simulator: true, signing: { ascApiKey: "secret:asc-api-key" } },
    ],
    [
      "a scheme that signs with exportOptionsPlist",
      { exportOptionsPlist: "export.plist" },
    ],
  ])("needs no key for %s", async (_, scheme) => {
    iosScheme = { configuration: "Release", ...scheme };
    await buildIosNative({ interactive: false, scheme: "release" });
    expect(ensureAscApiKey).not.toHaveBeenCalled();
  });
});
