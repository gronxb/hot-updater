import { stripVTControlCharacters } from "node:util";

import type { EnrichedNativeBuildAndroidScheme } from "@hot-updater/android-helper";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];

const serviceAccount = { json: '{"client_email":"uploader@example.com"}' };

vi.mock("@hot-updater/android-helper", () => ({
  PlayVersionCodeUsedError: class PlayVersionCodeUsedError extends Error {},
  assertPlaySigned: vi.fn(async () => {
    events.push("check signer");
  }),
  buildAndroid: vi.fn(async () => ({ logFilePath: null })),
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
vi.mock("@hot-updater/apple-helper", () => ({
  buildIos: vi.fn(async () => ({ logFilePath: null })),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
  p: {
    log: {
      info: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
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
vi.mock("../utils/native/playServiceAccount", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../utils/native/playServiceAccount")
  >()),
  checkGooglePlay: vi.fn(async ({ packageName }: { packageName: string }) => {
    events.push(`check play ${packageName}`);
    return { packageName, ready: true, checks: [] };
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
  issueMinBundleId: vi.fn(async () => "019a0000-0000-7000-8000-000000000000"),
  isNativeBuildConflict: () => false,
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

import { checkGooglePlay } from "../utils/native/playServiceAccount";
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
  it("checks the scheme and everything Google Play needs before the prebuild, then builds, registers and uploads", async () => {
    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(events).toEqual([
      "check scheme",
      "check play com.example.app",
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
        "Google Play refuses an .aab signed with the Android debug keystore.",
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

  it("checks Google Play with the scheme's applicationId, which the build reads", async () => {
    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(checkGooglePlay).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "com.example.app",
        serviceAccount: {
          kind: "play-service-account",
          name: "play-service-account",
        },
      }),
    );
  });

  it("stops before the prebuild with every unmet item when Google Play isn't ready", async () => {
    vi.mocked(checkGooglePlay).mockResolvedValueOnce({
      packageName: "com.example.app",
      ready: false,
      checks: [
        {
          ok: false,
          label: "Service account key",
          lines: [
            "npx hot-updater secrets put play-service-account <key.json>",
          ],
        },
        { ok: true, label: "Upload keystore" },
        {
          ok: undefined,
          label: "Play access",
          detail: "checked once the key is stored",
        },
      ],
    });
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
      }),
    ).rejects.toThrow("exit");

    expect(
      stripVTControlCharacters(
        vi.mocked(p.log.error).mock.calls.flat().join("\n"),
      ),
    ).toBe(
      [
        "Google Play isn't ready for com.example.app:",
        "✗ Service account key",
        "  npx hot-updater secrets put play-service-account <key.json>",
        "✓ Upload keystore",
        "· Play access          checked once the key is stored",
        "Guide: https://hot-updater.dev/docs/guides/native-build#set-up-google-play",
      ].join("\n"),
    );
    expect(events).not.toContain("prebuild");
    expect(events).not.toContain("resolve play-service-account");
    expect(createNativeBuild).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("a dry run still builds when Google Play isn't ready, and fails at the end with the same lines", async () => {
    vi.mocked(checkGooglePlay).mockResolvedValueOnce({
      packageName: "com.example.app",
      ready: false,
      checks: [
        { ok: true, label: "Service account key" },
        { ok: true, label: "Upload keystore" },
        {
          ok: false,
          label: "App in Play",
          detail: "upload the first .aab in Play Console",
        },
      ],
    });
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
        dryRun: true,
      }),
    ).rejects.toThrow("exit");

    expect(events).toContain("build");
    expect(uploadToPlay).not.toHaveBeenCalled();
    expect(
      stripVTControlCharacters(
        vi.mocked(p.log.error).mock.calls.flat().join("\n"),
      ),
    ).toContain(
      [
        "A real run couldn't submit to Google Play.",
        "Google Play isn't ready for com.example.app:",
      ].join("\n"),
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
        "The scheme release builds an .apk (aab: false); Google Play takes an .aab.",
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
      "The scheme release builds an .apk (aab: false); Google Play takes an .aab.",
    );
    expect(events).not.toContain("prebuild");
    expect(createNativeBuild).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("reports a failed upload with the path the build stays at", async () => {
    vi.mocked(uploadToPlay).mockRejectedValueOnce(
      new Error(
        "Google Play already has this .aab's version code.\nRaise versionCode for every build you upload.",
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
      `Google Play already has this .aab's version code.\nRaise versionCode for every build you upload.\nThe build stays at ${AAB}.`,
    );
    // The resolver deletes its temporary files before the process exits.
    expect(events.slice(-2)).toEqual(["dispose", "exit"]);
    exit.mockRestore();
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
