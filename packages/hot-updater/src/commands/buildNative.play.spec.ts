import type { EnrichedNativeBuildAndroidScheme } from "@hot-updater/android-helper";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];

const serviceAccount = { json: '{"client_email":"uploader@example.com"}' };

vi.mock("@hot-updater/android-helper", () => ({
  assertPlaySigned: vi.fn(async () => {
    events.push("check signer");
  }),
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
  p: {
    log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
  },
  withCredentialResolver: vi.fn(async (run) => {
    try {
      return await run({
        resolve: vi.fn(async (request) => {
          events.push(`resolve ${request.name}`);
          return serviceAccount;
        }),
        dispose: vi.fn(),
      });
    } finally {
      events.push("dispose");
    }
  }),
}));
vi.mock("../utils/native/playServiceAccount", () => ({
  ensurePlayServiceAccount: vi.fn(async ({ name }: { name: string }) => {
    events.push(`ensure ${name}`);
    return { status: "stored" };
  }),
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
    await options.beforePrebuild?.({
      scheme: "release",
      androidScheme: { packageName: "com.example.app" },
    });
    events.push("prebuild");
    return {
      buildAdapter: { name: "bare" },
      config: { cacheDir: null },
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
  // The tracking preflight passes: its own specs cover it.
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild: vi.fn(async () => {
    events.push("register");
  }),
}));

import {
  assertPlaySigned,
  readBuiltPackageName,
  resolvePlayUploadServiceAccount,
  uploadToPlay,
} from "@hot-updater/android-helper";
import { p } from "@hot-updater/cli-tools";

import { createNativeBuild } from "@/utils/native/createNativeBuild";

import { CredentialSetupRefusedError } from "../utils/native/issuedCredential";
import { ensurePlayServiceAccount } from "../utils/native/playServiceAccount";
import { handleNativeBuildCreate } from "./buildNative";

const AAB = "/out/app/build/outputs/bundle/app-staging-release.aab";

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
});

const mockExit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => {
    events.push("exit");
    throw new Error("exit");
  }) as never);

describe("native-build android --submit play-internal", () => {
  it("checks the scheme and resolves the service account before the prebuild, then builds, registers and uploads", async () => {
    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(events).toEqual([
      "check scheme",
      "ensure play-service-account",
      "resolve play-service-account",
      "prebuild",
      "build",
      "register",
      // The .aab's signer, before anything goes to Google Play.
      "check signer",
      "upload",
      "dispose",
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

  it("submits nothing when the .aab is debug-signed, saying why", async () => {
    vi.mocked(assertPlaySigned).mockRejectedValueOnce(
      new Error(
        "Google Play refuses an .aab signed with the Android debug keystore, and /out/app-release.aab is.",
      ),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
      }),
    ).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(uploadToPlay).not.toHaveBeenCalled();
    expect(vi.mocked(p.log.error).mock.calls.flat().join("\n")).toContain(
      "Google Play refuses an .aab signed with the Android debug keystore",
    );
  });

  it("asks for the key with the scheme's applicationId, which the build reads", async () => {
    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(ensurePlayServiceAccount).toHaveBeenCalledWith({
      name: "play-service-account",
      packageName: "com.example.app",
    });
  });

  it("stops before the prebuild, reported by canSignIn, when there is no key and no terminal", async () => {
    vi.mocked(ensurePlayServiceAccount).mockRejectedValueOnce(
      new CredentialSetupRefusedError("no terminal"),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).not.toHaveBeenCalled();
    expect(events).not.toContain("prebuild");
    expect(events).not.toContain("resolve play-service-account");
    exit.mockRestore();
  });

  it("reports why the key could not be issued before the prebuild", async () => {
    vi.mocked(ensurePlayServiceAccount).mockRejectedValueOnce(
      new Error("Google Play has no app com.example.app."),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      "Google Play has no app com.example.app.",
    );
    expect(events).not.toContain("prebuild");
    exit.mockRestore();
  });

  it("says a key issued in this run may not have its Play access yet when the upload fails", async () => {
    vi.mocked(ensurePlayServiceAccount).mockResolvedValueOnce({
      status: "issued",
      email: "hot-updater-play@p.iam.gserviceaccount.com",
    });
    vi.mocked(uploadToPlay).mockRejectedValueOnce(
      new Error("Opening a Google Play edit failed (HTTP 403)."),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      `Opening a Google Play edit failed (HTTP 403).\nIf Google Play refused the new service account, it may not have its access yet: the key is stored, so run the build again in a few minutes without signing in.\nThe build stays at ${AAB}.`,
    );
    exit.mockRestore();
  });

  it("uploads under the scheme's applicationId without aapt2", async () => {
    vi.mocked(readBuiltPackageName).mockResolvedValueOnce(undefined);

    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(uploadToPlay).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "com.example.app" }),
    );
  });

  it("submits nothing without --submit, and tracks the build", async () => {
    await handleNativeBuildCreate("android", {
      scheme: "release",
    });

    expect(events).toEqual(["prebuild", "build", "register", "dispose"]);
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
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
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
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      `Google Play already has this .aab's version code. Raise versionCode for every build you upload.\nThe build stays at ${AAB}.`,
    );
    // The resolver deletes its temporary files before the process exits.
    expect(events.slice(-2)).toEqual(["dispose", "exit"]);
    exit.mockRestore();
  });
});
