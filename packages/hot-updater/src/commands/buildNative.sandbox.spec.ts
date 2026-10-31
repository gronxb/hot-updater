import { stripVTControlCharacters } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
const APP_VERSION_TRAIN = {
  updateStrategy: "fingerprint",
  train: { highestClosedVersion: "1.6.2", highestBuildNumber: 68 },
};

/** The scheme the config sets, as beforePrebuild receives it. */
let iosScheme: Record<string, unknown>;
let target: { fingerprintHash: string | null; appVersion: string | null };
let audienceFailure: Error | null;
let ipaFailure: Error | null;
let artifactFailure: Error | null;
/** The artifact's version a cached build reports. */
let cachedVersion: string | undefined;

const ascApiKey = {
  keyPath: "/tmp/AuthKey_ABC.p8",
  keyId: "ABC",
  issuerId: "issuer",
};

vi.mock("@hot-updater/apple-helper", () => ({
  TestFlightBuildExistsError: class TestFlightBuildExistsError extends Error {},
  assertTestFlightExportOptions: vi.fn(),
  assertIpaIsInternalOnly: vi.fn(async () => {
    events.push("check ipa");
    if (ipaFailure) throw ipaFailure;
  }),
  assertBuildIsInternalOnly: vi.fn(async () => {
    events.push("check audience");
    if (audienceFailure) throw audienceFailure;
  }),
  buildIos: vi.fn(async () => ({ logFilePath: null })),
  findTestFlightBuild: vi.fn(async () => ({ found: false })),
  isVersionTrainClosed: vi.fn((version: string) => version === "1.6.2"),
  prepareSandboxArchive: vi.fn(async () => {
    events.push("read train");
    return APP_VERSION_TRAIN;
  }),
  resolveTestFlightUploadKey: vi.fn(() => ({
    kind: "asc-api-key",
    name: "asc-api-key",
  })),
  uploadToTestFlight: vi.fn(async () => {
    events.push("upload");
    return {
      appId: "123",
      buildUploadId: "upload-1",
      state: "COMPLETE",
      testFlightUrl: "https://example.com",
      shortVersion: "1.7.0",
      bundleVersion: "69",
    };
  }),
}));
vi.mock("@hot-updater/android-helper", () => ({
  buildAndroid: vi.fn(async () => ({ logFilePath: null })),
}));
vi.mock("../utils/native/ascApiKey", () => ({
  ensureAscApiKey: vi.fn(async () => ({ status: "stored" })),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
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
    run({ resolve: vi.fn(async () => ascApiKey), dispose: vi.fn() }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    await options.beforePrebuild?.({ scheme: "release", iosScheme });
    return {
      buildAdapter: { name: "bare" },
      config: { cacheDir: null, updateStrategy: "fingerprint" },
      outputPath: "/out",
      scheme: "release",
      target,
      iosSchemeConfig: {
        configuration: "Release",
        hotUpdaterSchemeName: "release",
        ...iosScheme,
      },
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
      channel: "sandbox-release",
      fingerprintHash: "fp",
      appVersion: null,
      artifactPath: "/out/export/App.ipa",
      artifactKind: "ipa",
    };
  }),
}));
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => ({
    platform: "ios",
    channel: "sandbox-release",
    fingerprintHash: "fp",
    appVersion: null,
  })),
}));
vi.mock("../utils/native/reuseNativeBuild", () => ({
  reuseNativeBuild: vi.fn(async () => ({
    key: { key: null, components: null, uncacheable: "it is a test" },
    slot: null,
    hit:
      cachedVersion === undefined
        ? null
        : {
            source: "local",
            nativeBuildId: null,
            result: {
              platform: "ios",
              scheme: "release",
              minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
              channel: "sandbox-release",
              fingerprintHash: "fp",
              appVersion: null,
              artifactPath: "/out/cached/App.ipa",
              artifactKind: "ipa",
            },
          },
    report: { hit: null, key: null, uncacheable: "it is a test", changed: [] },
    remember: vi.fn(async () => {}),
  })),
  rememberTrackedBuild: vi.fn(async () => {}),
}));
vi.mock("../utils/native/sandbox", () => ({
  assertSandboxBuildAllowed: vi.fn(async () => {
    events.push("check scheme");
  }),
  assertBuiltArtifact: vi.fn(async () => {
    events.push("check artifact");
    if (artifactFailure) throw artifactFailure;
    return null;
  }),
  readBuiltArtifact: vi.fn(async () => ({ appVersion: cachedVersion })),
}));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  NativeBuildUnreachableError: class extends Error {},
  issueMinBundleId: vi.fn(async () => "019a0000-0000-7000-8000-000000000000"),
  isNativeBuildConflict: () => false,
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild: vi.fn(async () => {
    events.push("register");
    return { id: "build-1" };
  }),
}));
vi.mock("../utils/native/nativeBuildSubmission", () => ({
  recordNativeBuildSubmission: vi.fn(async (build) => {
    events.push("record");
    return build;
  }),
  storeVersionLabel: (version: string, build: string) =>
    `${version} (${build})`,
}));

import { prepareSandboxArchive } from "@hot-updater/apple-helper";
import { p, secret } from "@hot-updater/cli-tools";

import { assertBuiltArtifact } from "../utils/native/sandbox";
import { handleNativeBuildCreate } from "./buildNative";

const fail = async (run: Promise<unknown>) => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  await expect(run).rejects.toThrow("process.exit");
  exit.mockRestore();
  return stripVTControlCharacters(
    vi
      .mocked(p.log.error)
      .mock.calls.map(([message]) => String(message))
      .join("\n"),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  target = { fingerprintHash: "fp", appVersion: null };
  audienceFailure = null;
  ipaFailure = null;
  artifactFailure = null;
  cachedVersion = undefined;
  iosScheme = {
    bundleIdentifier: "com.example.app",
    sandbox: true,
    simulator: false,
    signing: { ascApiKey: secret("asc-api-key") },
  };
});

describe("native-build of a sandbox scheme", () => {
  it("checks first, reads the store before it builds, and uploads only what it checked", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(events).toEqual([
      "check scheme",
      "check scheme",
      "read train",
      "build",
      "check artifact",
      "register",
      "check ipa",
      "upload",
      "check audience",
      "record",
    ]);
    expect(assertBuiltArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: true,
        channel: "sandbox-release",
        fingerprintHash: "fp",
      }),
    );
  });

  it("registers nothing when the artifact isn't what the scheme asked for", async () => {
    artifactFailure = new Error("The .ipa is a sandbox build.");
    const printed = await fail(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    );
    expect(printed).toContain("The .ipa is a sandbox build.");
    expect(events).not.toContain("register");
    expect(events).not.toContain("upload");
  });

  it("uploads nothing when the .ipa isn't marked internal only", async () => {
    ipaFailure = new Error("App.ipa isn't marked.");
    const printed = await fail(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    );
    expect(printed).toContain("App.ipa isn't marked.");
    expect(events).not.toContain("upload");
  });

  it("fails, and records nothing, when App Store Connect holds it for anyone else", async () => {
    audienceFailure = new Error("not INTERNAL_ONLY");
    const printed = await fail(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    );
    expect(printed).toContain("not INTERNAL_ONLY");
    expect(events).toContain("upload");
    expect(events).not.toContain("record");
  });

  it("builds anew when App Store Connect closed a cached build's version", async () => {
    cachedVersion = "1.6.2";
    await handleNativeBuildCreate("ios", { scheme: "release" });
    expect(events).toContain("build");
    expect(p.log.info).toHaveBeenCalledWith(
      "Cache skipped · version 1.6.2 is closed",
    );
  });

  it("reuses a cached build whose version is open", async () => {
    cachedVersion = "1.7.0";
    await handleNativeBuildCreate("ios", { scheme: "release" });
    expect(events).not.toContain("build");
  });

  it("builds under appVersion when the project's files declare a closed version, which an xcconfig may override", async () => {
    target = { fingerprintHash: null, appVersion: "1.6.2" };
    // Refuses as it would for a version that really is closed: only what the
    // archive holds may decide, so the project's version must not reach it.
    vi.mocked(prepareSandboxArchive).mockImplementationOnce((async ({
      appVersion,
    }: {
      appVersion?: string;
    }) => {
      if (appVersion === "1.6.2") {
        throw new Error("App Store Connect closed version 1.6.2.");
      }
      return APP_VERSION_TRAIN;
    }) as never);

    await handleNativeBuildCreate("ios", { scheme: "release" });

    expect(events).toContain("build");
    expect(p.log.error).not.toHaveBeenCalled();
  });

  it("reads no store for a simulator scheme", async () => {
    iosScheme = { ...iosScheme, simulator: true, signing: undefined };
    await handleNativeBuildCreate("ios", { scheme: "release" });
    expect(events).not.toContain("read train");
  });
});

describe("native-build of a normal scheme", () => {
  it("never checks the internal-only flag or the store's train", async () => {
    iosScheme = {
      bundleIdentifier: "com.example.app",
      signing: { ascApiKey: secret("asc-api-key") },
    };
    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(events).not.toContain("read train");
    expect(events).not.toContain("check ipa");
    expect(events).not.toContain("check audience");
    expect(events).toContain("check artifact");
    expect(assertBuiltArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ sandbox: false }),
    );
  });
});
