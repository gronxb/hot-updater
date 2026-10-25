import { beforeEach, describe, expect, it, vi } from "vitest";

const { events, prebuildScheme, resolve } = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    prebuildScheme: { current: {} as Record<string, unknown> },
    resolve: vi.fn(async (request: { kind: string; name: string }) => {
      events.push(`resolve ${request.kind} ${request.name}`);
      return {};
    }),
  };
});

vi.mock("@hot-updater/android-helper", () => ({
  buildAndroid: vi.fn(),
  readBuiltPackageName: vi.fn(),
  resolvePlayUploadServiceAccount: vi.fn(),
  uploadToPlay: vi.fn(),
}));
vi.mock("@hot-updater/apple-helper", () => ({
  assertTestFlightExportOptions: vi.fn(),
  buildIos: vi.fn(),
  resolveTestFlightUploadKey: vi.fn(),
  uploadToTestFlight: vi.fn(),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
  p: { log: { info: vi.fn(), success: vi.fn(), error: vi.fn() } },
  withCredentialResolver: vi.fn(async (run) =>
    run({ resolve, dispose: vi.fn() }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  registerNativeBuild: vi.fn(),
}));
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(async () => {
    events.push("build");
    return {
      platform: "android",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5",
      channel: "production",
      fingerprintHash: "fp",
      appVersion: null,
      artifactPath: "/out/app.aab",
      artifactKind: "aab",
    };
  }),
}));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    await options.beforePrebuild?.({
      scheme: "release",
      ...prebuildScheme.current,
    });
    events.push("prebuild");
    return {
      buildAdapter: { name: "bare" },
      outputPath: "/out",
      scheme: "release",
      target: { fingerprintHash: "fp", appVersion: null },
      androidSchemeConfig: { variant: "Release" },
      iosSchemeConfig: { configuration: "Release" },
    };
  }),
}));

import { CredentialUnavailableError, p } from "@hot-updater/cli-tools";

import { buildAndroidNative, buildIosNative } from "./buildNative";

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
});

describe("build:* resolves its signing credentials before the prebuild", () => {
  it("resolves a release variant's keystore first", async () => {
    prebuildScheme.current = {
      androidScheme: {
        packageName: "com.example.app",
        signing: { keystore: "vault:release-keystore" },
      },
    };

    await buildAndroidNative({ interactive: false, scheme: "release" });

    expect(events).toEqual([
      "resolve android-keystore release-keystore",
      "prebuild",
      "build",
    ]);
  });

  it("resolves no keystore for a Debug variant, which keeps the debug keystore", async () => {
    prebuildScheme.current = {
      androidScheme: {
        packageName: "com.example.app",
        variant: "stagingDebug",
        signing: { keystore: "vault:release-keystore" },
      },
    };

    await buildAndroidNative({ interactive: false, scheme: "release" });

    expect(events).toEqual(["prebuild", "build"]);
  });

  it("resolves an iOS device build's App Store Connect API key first", async () => {
    prebuildScheme.current = {
      iosScheme: {
        bundleIdentifier: "com.example.app",
        signing: { ascApiKey: "vault:widget-asc" },
      },
    };

    await buildIosNative({ interactive: false, scheme: "release" });

    expect(events).toEqual([
      "resolve asc-api-key widget-asc",
      "prebuild",
      "build",
    ]);
  });

  it("resolves nothing for a simulator build, which signs nothing", async () => {
    prebuildScheme.current = {
      iosScheme: {
        bundleIdentifier: "com.example.app",
        simulator: true,
        signing: { ascApiKey: "vault:widget-asc" },
      },
    };

    await buildIosNative({ interactive: false, scheme: "release" });

    expect(events).toEqual(["prebuild", "build"]);
  });

  it("fails before the prebuild when the vault lacks the keystore", async () => {
    prebuildScheme.current = {
      androidScheme: {
        packageName: "com.example.app",
        signing: { keystore: "vault:release-keystore" },
      },
    };
    resolve.mockImplementationOnce(async (request) => {
      events.push(`resolve ${request.kind} ${request.name}`);
      throw new CredentialUnavailableError(
        "android-keystore",
        "release-keystore (android-keystore) is not in the vault at https://console.example.com.",
      );
    });
    vi.spyOn(process, "exit").mockImplementation((() => {
      events.push("exit");
      throw new Error("exit");
    }) as never);

    await expect(
      buildAndroidNative({ interactive: false, scheme: "release" }),
    ).rejects.toThrow("exit");

    expect(events).toEqual([
      "resolve android-keystore release-keystore",
      "exit",
    ]);
    expect(p.log.error).toHaveBeenCalledWith(
      "release-keystore (android-keystore) is not in the vault at https://console.example.com.",
    );
  });
});
