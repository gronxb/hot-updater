import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const serviceAccount = { json: '{"client_email":"uploader@example.com"}' };

let androidScheme: Record<string, unknown>;
/** The version code a cached build reports, or none without a cached build. */
let cachedBuildNumber: string | undefined;
let uploadStatus: "completed" | "draft";

vi.mock("@hot-updater/android-helper", () => ({
  PlayVersionCodeUsedError: class PlayVersionCodeUsedError extends Error {},
  assertPlaySigned: vi.fn(async () => {}),
  buildAndroid: vi.fn(async () => ({ logFilePath: null })),
  findPlayInternalRelease: vi.fn(async () => false),
  playTestingUrl: (name: string) => `https://play.test/${name}`,
  readBuiltApp: vi.fn(async () => ({ appVersion: "1.7.0" })),
  readBuiltPackageName: vi.fn(async () => "com.example.app.sandbox"),
  readBuiltVersionCode: vi.fn(async () => 42),
  readPlayHighestVersionCode: vi.fn(async () => {
    events.push("read version codes");
    return 41;
  }),
  resolvePlayUploadServiceAccount: vi.fn(() => ({
    kind: "play-service-account",
    name: "play-service-account",
  })),
  uploadToPlay: vi.fn(async () => {
    events.push("upload");
    return { versionCode: 42, status: uploadStatus };
  }),
}));
vi.mock("@hot-updater/apple-helper", () => ({
  buildIos: vi.fn(),
  TestFlightBuildExistsError: class extends Error {},
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
      message: vi.fn(),
    },
  },
  withCredentialResolver: vi.fn(async (run) =>
    run({ resolve: vi.fn(async () => serviceAccount), dispose: vi.fn() }),
  ),
}));
vi.mock("../utils/native/playServiceAccount", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../utils/native/playServiceAccount")
  >()),
  checkGooglePlay: vi.fn(async ({ packageName }: { packageName: string }) => ({
    packageName,
    ready: true,
    checks: [],
  })),
}));
vi.mock("../utils/version/getAndroidVersion", () => ({
  resolveSandboxApplicationId: vi.fn(async () => "com.example.app.sandbox"),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    await options.beforePrebuild?.({ scheme: "sandbox", androidScheme });
    return {
      buildAdapter: { name: "bare" },
      config: { cacheDir: null, updateStrategy: "fingerprint" },
      outputPath: "/out",
      scheme: "sandbox",
      target: { fingerprintHash: "fp", appVersion: null },
      androidSchemeConfig: androidScheme,
    };
  }),
}));
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(async ({ builder }) => {
    events.push("build");
    await builder();
    return {
      platform: "android",
      scheme: "sandbox",
      minBundleId: "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5",
      channel: "sandbox-sandbox",
      fingerprintHash: "fp",
      appVersion: null,
      artifactPath: "/out/app.aab",
      artifactKind: "aab",
    };
  }),
}));
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => null),
}));
vi.mock("../utils/native/reuseNativeBuild", () => ({
  reuseNativeBuild: vi.fn(async () => ({
    key: { key: null, components: null, uncacheable: "it is a test" },
    slot: null,
    hit:
      cachedBuildNumber === undefined
        ? null
        : {
            source: "local",
            nativeBuildId: null,
            result: {
              platform: "android",
              scheme: "sandbox",
              minBundleId: "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5",
              channel: "sandbox-sandbox",
              fingerprintHash: "fp",
              appVersion: null,
              artifactPath: "/out/cached.aab",
              artifactKind: "aab",
              buildNumber: cachedBuildNumber,
            },
          },
    report: { hit: null, key: null, uncacheable: "it is a test", changed: [] },
    remember: vi.fn(async () => {}),
  })),
  rememberTrackedBuild: vi.fn(async () => {}),
}));
vi.mock("../utils/native/sandbox", () => ({
  assertSandboxBuildAllowed: vi.fn(async () => {}),
  assertBuiltArtifact: vi.fn(async () => null),
  readBuiltArtifact: vi.fn(async () => ({})),
}));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  NativeBuildUnreachableError: class extends Error {},
  issueMinBundleId: vi.fn(async () => "019a0000-0000-7000-8000-000000000000"),
  isNativeBuildConflict: () => false,
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild: vi.fn(async () => ({ id: "build-1" })),
}));
vi.mock("../utils/native/nativeBuildSubmission", () => ({
  recordNativeBuildSubmission: vi.fn(async (build) => build),
  storeVersionLabel: (version: string, build: string) =>
    `${version} (${build})`,
}));

import {
  buildAndroid,
  readPlayHighestVersionCode,
} from "@hot-updater/android-helper";
import { p } from "@hot-updater/cli-tools";

import { handleNativeBuildCreate } from "./buildNative";

const printedJson = async (run: () => Promise<unknown>) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await run();
  const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  log.mockRestore();
  return printed;
};

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  cachedBuildNumber = undefined;
  uploadStatus = "completed";
  androidScheme = {
    packageName: "com.example.app",
    aab: true,
    variant: "Release",
    sandbox: true,
  };
});

describe("native-build android of a sandbox scheme --submit play-internal", () => {
  it("reads the store's highest version code before it builds, and builds past it", async () => {
    await handleNativeBuildCreate("android", {
      scheme: "sandbox",
      submit: "play-internal",
    });

    expect(events).toEqual(["read version codes", "build", "upload"]);
    expect(readPlayHighestVersionCode).toHaveBeenCalledWith({
      packageName: "com.example.app.sandbox",
      serviceAccount,
    });
    expect(buildAndroid).toHaveBeenCalledWith(
      expect.objectContaining({ minVersionCode: 42 }),
    );
  });

  it("prints the testing link and the release's state", async () => {
    const printed = await printedJson(() =>
      handleNativeBuildCreate("android", {
        scheme: "sandbox",
        submit: "play-internal",
        json: true,
      }),
    );
    expect(printed.submission.store).toEqual({
      destination: "play-internal",
      url: "https://play.test/com.example.app.sandbox",
      version: "1.7.0 (42)",
      state: "ready",
      expiresAtMs: null,
      reusable: true,
    });
  });

  it("says a release on an unpublished app is a draft", async () => {
    uploadStatus = "draft";
    const printed = await printedJson(() =>
      handleNativeBuildCreate("android", {
        scheme: "sandbox",
        submit: "play-internal",
        json: true,
      }),
    );
    expect(printed.submission.store.state).toBe("draft");
  });

  it("builds anew when the store has a cached build's version code and no record says it is this one", async () => {
    cachedBuildNumber = "41";
    const printed = await printedJson(() =>
      handleNativeBuildCreate("android", {
        scheme: "sandbox",
        submit: "play-internal",
        json: true,
      }),
    );
    expect(events).toContain("build");
    expect(p.log.info).toHaveBeenCalledWith(
      "Cache skipped · the store has build 41",
    );
    expect(printed.cache.uncacheable).toBe("the store has build 41");
  });

  it("uploads a cached build the store refused nothing of yet", async () => {
    cachedBuildNumber = "42";
    await handleNativeBuildCreate("android", {
      scheme: "sandbox",
      submit: "play-internal",
    });
    expect(events).not.toContain("build");
    expect(events).toContain("upload");
  });
});

describe("native-build android without a store", () => {
  it("reads no store for a sandbox scheme with no --submit", async () => {
    await handleNativeBuildCreate("android", { scheme: "sandbox" });
    expect(readPlayHighestVersionCode).not.toHaveBeenCalled();
    expect(buildAndroid).toHaveBeenCalledWith(
      expect.not.objectContaining({ minVersionCode: expect.anything() }),
    );
  });

  it("keeps a normal scheme's own version code on an upload", async () => {
    androidScheme = { ...androidScheme, sandbox: false };
    await handleNativeBuildCreate("android", {
      scheme: "sandbox",
      submit: "play-internal",
    });
    expect(readPlayHighestVersionCode).not.toHaveBeenCalled();
    expect(buildAndroid).toHaveBeenCalledWith(
      expect.not.objectContaining({ minVersionCode: expect.anything() }),
    );
  });
});
