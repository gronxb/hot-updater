import type { EnrichedNativeBuildAndroidScheme } from "@hot-updater/android-helper";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];

const serviceAccount = { json: '{"client_email":"uploader@example.com"}' };

vi.mock("@hot-updater/android-helper", () => ({
  buildAndroid: vi.fn(),
  readBuiltPackageName: vi.fn(async () => "com.example.app.staging"),
  resolvePlayUploadServiceAccount: vi.fn(() => {
    events.push("check scheme");
    return { kind: "play-service-account", name: "play-service-account" };
  }),
  uploadToPlay: vi.fn(async () => {
    events.push("upload");
    return { versionCode: 42, status: "completed" };
  }),
}));
vi.mock("@hot-updater/apple-helper", () => ({ buildIos: vi.fn() }));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
  p: { log: { info: vi.fn(), success: vi.fn(), error: vi.fn() } },
  withCredentialResolver: vi.fn(async (run) =>
    run({
      resolve: vi.fn(async (request) => {
        events.push(`resolve ${request.name}`);
        return serviceAccount;
      }),
      dispose: vi.fn(),
    }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    const androidSchemeConfig = {
      aab: true,
      variant: "stagingRelease",
      applicationId: "com.example.app",
    } as unknown as EnrichedNativeBuildAndroidScheme;
    await options.beforePrebuild?.({ androidSchemeConfig });
    events.push("prebuild");
    return {
      buildAdapter: { name: "bare" },
      outputPath: "/out",
      scheme: "release",
      target: { fingerprintHash: "fp", appVersion: null },
      androidSchemeConfig,
    };
  }),
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
      artifactPath: "/out/app/build/outputs/bundle/app-staging-release.aab",
      artifactKind: "aab",
    };
  }),
}));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  registerNativeBuild: vi.fn(async () => {
    events.push("register");
  }),
}));

import {
  readBuiltPackageName,
  resolvePlayUploadServiceAccount,
  uploadToPlay,
} from "@hot-updater/android-helper";
import { p } from "@hot-updater/cli-tools";

import { createNativeBuild } from "@/utils/native/createNativeBuild";

import { buildAndroidNative } from "./buildNative";

const AAB = "/out/app/build/outputs/bundle/app-staging-release.aab";

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
});

const mockExit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);

describe("build:android --upload play-internal", () => {
  it("checks the scheme and resolves the service account before the prebuild, then builds, registers and uploads", async () => {
    await buildAndroidNative({
      interactive: false,
      scheme: "release",
      register: true,
      upload: "play-internal",
    });

    expect(events).toEqual([
      "check scheme",
      "resolve play-service-account",
      "prebuild",
      "build",
      "register",
      "upload",
    ]);
    expect(readBuiltPackageName).toHaveBeenCalledWith({
      artifactPath: AAB,
      androidProjectPath: "/project/android",
    });
    expect(uploadToPlay).toHaveBeenCalledWith({
      aabPath: AAB,
      packageName: "com.example.app.staging",
      serviceAccount,
    });
  });

  it("uploads under the scheme's applicationId without aapt2", async () => {
    vi.mocked(readBuiltPackageName).mockResolvedValueOnce(undefined);

    await buildAndroidNative({
      interactive: false,
      scheme: "release",
      upload: "play-internal",
    });

    expect(uploadToPlay).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "com.example.app" }),
    );
  });

  it("uploads nothing without --upload", async () => {
    await buildAndroidNative({ interactive: false, scheme: "release" });

    expect(events).toEqual(["prebuild", "build"]);
    expect(resolvePlayUploadServiceAccount).not.toHaveBeenCalled();
  });

  it("refuses a scheme Google Play would not take before the prebuild", async () => {
    vi.mocked(resolvePlayUploadServiceAccount).mockImplementationOnce(() => {
      throw new Error(
        "Google Play takes an .aab, and the scheme release builds an .apk (aab: false).",
      );
    });
    const exit = mockExit();

    await expect(
      buildAndroidNative({
        interactive: false,
        scheme: "release",
        upload: "play-internal",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      "Google Play takes an .aab, and the scheme release builds an .apk (aab: false).",
    );
    expect(events).not.toContain("prebuild");
    expect(createNativeBuild).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("reports a failed upload with the path the build stays at", async () => {
    vi.mocked(uploadToPlay).mockRejectedValueOnce(
      new Error(
        "Google Play already has this .aab's version code. Raise versionCode for every build you upload.",
      ),
    );
    const exit = mockExit();

    await expect(
      buildAndroidNative({
        interactive: false,
        scheme: "release",
        upload: "play-internal",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      `Google Play already has this .aab's version code. Raise versionCode for every build you upload.\nThe build stays at ${AAB}.`,
    );
    exit.mockRestore();
  });
});
