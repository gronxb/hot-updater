import { stripVTControlCharacters } from "node:util";

import { p } from "@hot-updater/cli-tools";
import type { NativeBuildRow, Platform } from "@hot-updater/plugin-core";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";

/**
 * A build submitted to a store is recorded on its tracked row, which these
 * tests read back from a real core: only after the store accepted the
 * upload or already had the build, never on a dry run or a failed upload.
 */
const databaseHarness = createDatabaseHarness();

const ascApiKey = { keyPath: "/tmp/AuthKey.p8", keyId: "K", issuerId: "I" };
const serviceAccount = { json: '{"client_email":"uploader@example.com"}' };

/** The cached build a run reuses, when a test sets one. */
let reused: "local" | "storage" | null = null;
/** The tracked build a storage hit reuses. */
let storageRow: NativeBuildRow | null = null;
let platform: Platform = "ios";

const minBundleId = {
  ios: "0190a1b2-c3d4-7000-8000-000000000000",
  android: "0190a1b2-c3d5-7000-8000-000000000000",
} as const;

const buildResult = () =>
  platform === "ios"
    ? {
        platform: "ios" as const,
        scheme: "release",
        minBundleId: minBundleId.ios,
        channel: "production",
        fingerprintHash: "fp",
        appVersion: null,
        artifactPath: "/out/export/App.ipa",
        artifactKind: "ipa" as const,
      }
    : {
        platform: "android" as const,
        scheme: "release",
        minBundleId: minBundleId.android,
        channel: "production",
        fingerprintHash: "fp",
        appVersion: null,
        artifactPath: "/out/app-release.aab",
        artifactKind: "aab" as const,
      };

vi.mock("@hot-updater/apple-helper", async (importOriginal) => ({
  // The store's own refusal, as the upload throws it.
  TestFlightBuildExistsError: (
    await importOriginal<typeof import("@hot-updater/apple-helper")>()
  ).TestFlightBuildExistsError,
  assertTestFlightExportOptions: vi.fn(async () => {}),
  buildIos: vi.fn(),
  installPodsIfNeeded: vi.fn(async () => {}),
  resolveTestFlightUploadKey: vi.fn(() => ({
    kind: "asc-api-key",
    name: "asc-api-key",
  })),
  findTestFlightBuild: vi.fn(async () => ({ found: false })),
  uploadToTestFlight: vi.fn(async () => ({
    appId: "123",
    buildUploadId: "upload-1",
    state: "COMPLETE",
    testFlightUrl: "https://appstoreconnect.apple.com/apps/123/testflight/ios",
    shortVersion: "1.7.0",
    bundleVersion: "66",
  })),
}));
vi.mock("@hot-updater/android-helper", async (importOriginal) => ({
  PlayVersionCodeUsedError: (
    await importOriginal<typeof import("@hot-updater/android-helper")>()
  ).PlayVersionCodeUsedError,
  assertPlaySigned: vi.fn(async () => {}),
  buildAndroid: vi.fn(),
  findPlayInternalRelease: vi.fn(async () => false),
  readBuiltApp: vi.fn(async () => ({ appVersion: "1.7.0", channel: null })),
  readBuiltPackageName: vi.fn(async () => "com.example.app"),
  readBuiltVersionCode: vi.fn(async () => 66),
  resolvePlayUploadServiceAccount: vi.fn(() => ({
    kind: "play-service-account",
    name: "play-service-account",
  })),
  uploadToPlay: vi.fn(async () => ({ versionCode: 66, status: "completed" })),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
  loadConfig: vi.fn(async () => ({})),
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
    run({
      resolve: vi.fn(async (request: { kind: string }) =>
        request.kind === "asc-api-key" ? ascApiKey : serviceAccount,
      ),
      dispose: vi.fn(),
    }),
  ),
}));
vi.mock("../utils/native/ascApiKey", () => ({
  ensureAscApiKey: vi.fn(async () => ({ status: "stored" })),
}));
// Google Play is ready: playServiceAccount.spec.ts covers its checks.
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
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    await options.beforePrebuild?.(
      platform === "ios"
        ? {
            scheme: "release",
            iosScheme: {
              configuration: "Release",
              bundleIdentifier: "com.example.app",
            },
          }
        : {
            scheme: "release",
            androidScheme: { packageName: "com.example.app" },
          },
    );
    return {
      buildAdapter: { name: "bare" },
      config: { cacheDir: null },
      outputPath: "/out",
      scheme: "release",
      target: { fingerprintHash: "fp", appVersion: null },
      ...(platform === "ios"
        ? {
            iosSchemeConfig: {
              configuration: "Release",
              signing: { ascApiKey: "secret:asc-api-key" },
            },
          }
        : {
            androidSchemeConfig: {
              aab: true,
              variant: "release",
              applicationId: "com.example.app",
              signing: { serviceAccount: "secret:play-service-account" },
            },
          }),
    };
  }),
}));
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(async () => buildResult()),
}));
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => ({
    platform,
    channel: "production",
    fingerprintHash: "fp",
    appVersion: null,
  })),
}));
vi.mock("../utils/native/reuseNativeBuild", () => ({
  reuseNativeBuild: vi.fn(async () => ({
    key: { key: null, components: null, uncacheable: "it is a test" },
    slot: null,
    hit:
      reused === "local"
        ? { source: "local", nativeBuildId: null, result: buildResult() }
        : reused === "storage"
          ? {
              source: "storage",
              nativeBuild: storageRow,
              result: buildResult(),
            }
          : null,
    report: { hit: reused, key: null, uncacheable: null, changed: [] },
    remember: vi.fn(async () => {}),
  })),
  rememberTrackedBuild: vi.fn(async () => {}),
}));
/** Tracks the build in the test's core, as the CLI's registration does. */
vi.mock("@/utils/native/registerNativeBuild", () => ({
  issueMinBundleId: vi.fn(async () => buildResult().minBundleId),
  isNativeBuildConflict: () => false,
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild: vi.fn(async () => {
    const build = buildResult();
    return databaseHarness.core.registerNativeBuild({
      id: build.platform === "ios" ? nativeBuildId.ios : nativeBuildId.android,
      platform: build.platform,
      channel: build.channel,
      fingerprintHash: "fp",
      appVersion: null,
      minBundleId: build.minBundleId,
      gitCommitHash: null,
      buildKey: null,
      artifact: {
        kind: build.artifactKind,
        storageUri: `storage://native-builds/${build.platform}/app`,
        byteSize: 1,
      },
      embeddedBundle: {
        manifestStorageUri: "storage://bundles/manifest.json",
        manifestFileHash: "manifest-hash",
        assetBaseStorageUri: "storage://assets",
      },
    });
  }),
}));
// The record goes to the test's core, as `loadServer` gives it the config's.
vi.mock("../utils/loadServer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/loadServer")>()),
  loadServer: vi.fn(async () =>
    testServer({ database: databaseHarness.database }),
  ),
}));

const nativeBuildId = {
  ios: "0190a1b2-c3d4-7000-8000-0000000000e1",
  android: "0190a1b2-c3d4-7000-8000-0000000000e2",
} as const;

import {
  findPlayInternalRelease,
  readBuiltApp,
  uploadToPlay,
} from "@hot-updater/android-helper";
import {
  findTestFlightBuild,
  uploadToTestFlight,
} from "@hot-updater/apple-helper";

import { handleNativeBuildCreate } from "./buildNative";

/** What `p.log.step` printed, without colors, which CI turns on. */
const stepped = () =>
  vi
    .mocked(p.log.step)
    .mock.calls.map(([message]) => stripVTControlCharacters(String(message)));

const stored = (): Promise<NativeBuildRow | null> =>
  databaseHarness.core.getNativeBuild(nativeBuildId[platform]);

const submission = (row: NativeBuildRow | null) => ({
  submitted_to: row?.submitted_to,
  submitted_version: row?.submitted_version,
  recorded: typeof row?.submitted_at_ms === "number",
});

const NONE = { submitted_to: null, submitted_version: null, recorded: false };

const mockExit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);

beforeEach(() => {
  vi.clearAllMocks();
  databaseHarness.reset();
  reused = null;
  storageRow = null;
  platform = "ios";
});

/** Tracks the build as an earlier run did, submitted to `destination`. */
const trackSubmitted = async (
  destination: "testflight" | "play-internal",
  version: string,
) => {
  const { registerNativeBuild } =
    await import("@/utils/native/registerNativeBuild");
  const row = (await registerNativeBuild(buildResult() as never, {
    buildKey: null,
  })) as NativeBuildRow;
  return (await databaseHarness.core.recordNativeBuildSubmission(row.id, {
    destination,
    version,
  }))!;
};

/** The last line `--json` printed. */
const lastJson = (log: { mock: { calls: unknown[][] } }) =>
  JSON.parse(String(log.mock.calls.at(-1)?.[0]));

describe("native-build ios --submit testflight", () => {
  it("records TestFlight and the build's version and number once App Store Connect accepted it", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(submission(await stored())).toEqual({
      submitted_to: "testflight",
      submitted_version: "1.7.0 (66)",
      recorded: true,
    });
  });

  it("records nothing for a build App Store Connect is still processing", async () => {
    vi.mocked(uploadToTestFlight).mockResolvedValueOnce({
      appId: "123",
      buildUploadId: "upload-1",
      state: "PROCESSING",
      testFlightUrl: "https://asc",
      shortVersion: "1.7.0",
      bundleVersion: "66",
    });

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(submission(await stored())).toEqual(NONE);
  });

  it("records nothing when the upload fails", async () => {
    vi.mocked(uploadToTestFlight).mockRejectedValueOnce(
      new Error("App Store Connect refused the build"),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    ).rejects.toThrow("exit");

    exit.mockRestore();
    // The build is tracked, and no store took it.
    expect(await stored()).not.toBeNull();
    expect(submission(await stored())).toEqual(NONE);
  });

  it("writes nothing on a dry run, and uploads nothing", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
      dryRun: true,
    });

    expect(uploadToTestFlight).not.toHaveBeenCalled();
    expect(await stored()).toBeNull();
  });

  it("skips a reused build TestFlight already has, and records nothing: the store matched its number, not the artifact", async () => {
    reused = "local";
    vi.mocked(findTestFlightBuild).mockResolvedValueOnce({
      found: true,
      shortVersion: "1.7.0",
      bundleVersion: "65",
      testFlightUrl: "https://asc",
    } as never);

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(uploadToTestFlight).not.toHaveBeenCalled();
    expect(submission(await stored())).toEqual(NONE);
  });

  it("skips a reused build already submitted to TestFlight, with no store call, and succeeds", async () => {
    storageRow = await trackSubmitted("testflight", "1.7.0 (66)");
    reused = "storage";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
      json: true,
    });

    const printed = lastJson(log);
    log.mockRestore();
    expect(findTestFlightBuild).not.toHaveBeenCalled();
    expect(uploadToTestFlight).not.toHaveBeenCalled();
    const since = new Date(storageRow.submitted_at_ms!)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    expect(stepped()).toContain(
      `Already on TestFlight\nVersion  1.7.0 (66)\nSince    ${since} UTC`,
    );
    expect(printed.submission).toEqual({
      destination: "testflight",
      skipped: "already-submitted",
      existing: {
        destination: "testflight",
        version: "1.7.0 (66)",
        submittedAtMs: storageRow.submitted_at_ms,
        source: "recorded",
      },
    });
    // The record stays the first upload's.
    expect(await stored()).toEqual(storageRow);
  });

  it("skips, records nothing, and succeeds when App Store Connect already has the build number", async () => {
    const { TestFlightBuildExistsError } =
      await import("@hot-updater/apple-helper");
    vi.mocked(uploadToTestFlight).mockRejectedValueOnce(
      new TestFlightBuildExistsError("1.7.0", "66"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
      json: true,
    });

    const printed = lastJson(log);
    log.mockRestore();
    expect(stepped()).toContain(
      "Already on TestFlight\nVersion  1.7.0 (66)\nBump the build number to upload this build.",
    );
    expect(printed.submission).toMatchObject({
      skipped: "already-submitted",
      existing: { version: "1.7.0 (66)", source: "store", submittedAtMs: null },
    });
    // The store's build may be another artifact: nothing is recorded.
    expect(submission(await stored())).toEqual(NONE);
  });

  it("records nothing without --submit", async () => {
    await handleNativeBuildCreate("ios", { scheme: "release" });

    expect(submission(await stored())).toEqual(NONE);
  });
});

describe("native-build android --submit play-internal", () => {
  beforeEach(() => {
    platform = "android";
  });

  it.each(["completed", "draft"] as const)(
    "records Play internal and the version name and code for a %s release",
    async (status) => {
      vi.mocked(uploadToPlay).mockResolvedValueOnce({
        versionCode: 66,
        status,
      });

      await handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
      });

      expect(submission(await stored())).toEqual({
        submitted_to: "play-internal",
        submitted_version: "1.7.0 (66)",
        recorded: true,
      });
    },
  );

  it("labels the build by its version code alone when the artifact's version name can't be read", async () => {
    vi.mocked(readBuiltApp).mockResolvedValueOnce(undefined);

    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(submission(await stored())).toMatchObject({
      submitted_version: "66",
    });
  });

  it("records nothing when Google Play refuses the upload", async () => {
    vi.mocked(uploadToPlay).mockRejectedValueOnce(
      new Error("Google Play already has this version code"),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("android", {
        scheme: "release",
        submit: "play-internal",
      }),
    ).rejects.toThrow("exit");

    exit.mockRestore();
    expect(submission(await stored())).toEqual(NONE);
  });

  it("skips a reused build already submitted to Google Play, without asking the store", async () => {
    storageRow = await trackSubmitted("play-internal", "1.7.0 (66)");
    reused = "storage";

    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(findPlayInternalRelease).not.toHaveBeenCalled();
    expect(uploadToPlay).not.toHaveBeenCalled();
    expect(await stored()).toEqual(storageRow);
  });

  it("skips, records nothing, and succeeds when Google Play already has the version code", async () => {
    const { PlayVersionCodeUsedError } =
      await import("@hot-updater/android-helper");
    vi.mocked(uploadToPlay).mockRejectedValueOnce(
      new PlayVersionCodeUsedError(),
    );

    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(stepped()).toContain(
      "Already on Google Play internal testing\nVersion  1.7.0 (66)\nBump the build number to upload this build.",
    );
    expect(submission(await stored())).toEqual(NONE);
  });

  it("skips a reused build Google Play already has, and records nothing: the store matched its version code, not the artifact", async () => {
    reused = "local";
    vi.mocked(findPlayInternalRelease).mockResolvedValueOnce(true);

    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
    });

    expect(uploadToPlay).not.toHaveBeenCalled();
    expect(submission(await stored())).toEqual(NONE);
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
