import { p } from "@hot-updater/cli-tools";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
/** Whether the iOS scheme sets installPods. */
let installPods = false;

const ascApiKey = {
  keyPath: "/tmp/AuthKey_ABC.p8",
  keyId: "ABC",
  issuerId: "issuer",
};
const serviceAccount = { json: '{"client_email":"uploader@example.com"}' };

vi.mock("@hot-updater/apple-helper", () => ({
  TestFlightBuildExistsError: class TestFlightBuildExistsError extends Error {},
  assertTestFlightExportOptions: vi.fn(async () => {}),
  buildIos: vi.fn(async () => ({ logFilePath: null })),
  installPodsIfNeeded: vi.fn(async () => {
    events.push("pod install");
  }),
  findTestFlightBuild: vi.fn(async () => {
    events.push("find on TestFlight");
    return {
      found: true,
      testFlightUrl: "https://appstoreconnect.apple.com/apps/1/testflight/ios",
      shortVersion: "1.0.0",
      bundleVersion: "7",
    };
  }),
  resolveTestFlightUploadKey: vi.fn(() => ({
    kind: "asc-api-key",
    name: "asc-api-key",
  })),
  uploadToTestFlight: vi.fn(async () => {
    events.push("upload");
    return { state: "COMPLETE", testFlightUrl: "https://asc" };
  }),
}));
vi.mock("@hot-updater/android-helper", () => ({
  PlayVersionCodeUsedError: class PlayVersionCodeUsedError extends Error {},
  readBuiltApp: vi.fn(async () => undefined),
  buildAndroid: vi.fn(async () => ({ logFilePath: null })),
  findPlayInternalRelease: vi.fn(async () => {
    events.push("find on Play");
    return true;
  }),
  readBuiltPackageName: vi.fn(async () => "com.example.app"),
  readBuiltVersionCode: vi.fn(async () => 42),
  resolvePlayUploadServiceAccount: vi.fn(() => ({
    kind: "play-service-account",
    name: "play-service-account",
  })),
  uploadToPlay: vi.fn(async () => {
    events.push("upload");
    return { versionCode: 42, status: "completed" };
  }),
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
    run({
      resolve: vi.fn(async ({ kind }: { kind: string }) =>
        kind === "asc-api-key" ? ascApiKey : serviceAccount,
      ),
      dispose: vi.fn(),
    }),
  ),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    await options.beforePrebuild?.(
      options.platform === "ios"
        ? {
            scheme: "release",
            iosScheme: {
              configuration: "Release",
              signing: { ascApiKey: "secret:asc-api-key" },
            },
          }
        : {
            scheme: "release",
            androidScheme: { packageName: "com.example.app" },
          },
    );
    return {
      buildAdapter: { name: "bare" },
      config: { cacheDir: "node_modules/.hot-updater" },
      outputPath: "/out",
      scheme: "release",
      target: { fingerprintHash: "fp", appVersion: null },
      ...(options.platform === "ios"
        ? {
            iosSchemeConfig: {
              configuration: "Release",
              installPods,
              signing: { ascApiKey: "secret:asc-api-key" },
            },
          }
        : {
            androidSchemeConfig: {
              aab: true,
              variant: "release",
              applicationId: "com.example.app",
            },
          }),
    };
  }),
}));
const built = {
  platform: "ios",
  scheme: "release",
  minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
  channel: "production",
  fingerprintHash: "fp",
  appVersion: null,
  artifactPath: "/out/export/App.ipa",
  artifactKind: "ipa",
} as const;
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(async ({ builder }) => {
    events.push("build");
    await builder();
    return built;
  }),
}));
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => null),
}));
const row = { id: "0190a1b2-c3d4-7000-8000-00000000b001" };
vi.mock("@/utils/native/registerNativeBuild", () => ({
  issueMinBundleId: vi.fn(async () => "019a0000-0000-7000-8000-000000000000"),
  isNativeBuildConflict: () => false,
  preflightNativeBuildRegistration: vi.fn(async () => {}),
  registerNativeBuild: vi.fn(async () => {
    events.push("register");
    return row;
  }),
}));
// Recording a store submission: buildNative.submission.spec.ts covers it
// over a real core.
vi.mock("../utils/native/nativeBuildSubmission", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../utils/native/nativeBuildSubmission")
  >()),
  recordNativeBuildSubmission: vi.fn(async (build) => build),
}));
vi.mock("../utils/native/reuseNativeBuild", () => ({
  reuseNativeBuild: vi.fn(),
  rememberTrackedBuild: vi.fn(async () => {
    events.push("remember tracked");
  }),
}));

import {
  buildIos,
  findTestFlightBuild,
  installPodsIfNeeded,
  uploadToTestFlight,
} from "@hot-updater/apple-helper";

import { registerNativeBuild } from "@/utils/native/registerNativeBuild";

import {
  type NativeBuildCache,
  rememberTrackedBuild,
  reuseNativeBuild,
} from "../utils/native/reuseNativeBuild";
import { handleNativeBuildCreate } from "./buildNative";

const KEY = `nbk1:${"1".repeat(64)}`;
const cached = {
  ...built,
  minBundleId: "0190a1b2-c3d4-7000-8000-0000000000c1",
};
const tracked = { id: "0190a1b2-c3d4-7000-8000-00000000b002" };

/** What reuseNativeBuild returns: a miss, or a hit from `source`. */
const cacheOf = (
  source: "storage" | "local" | null,
  changed: string[] = [],
): NativeBuildCache => {
  const hit =
    source === "storage"
      ? { source, nativeBuild: tracked as never, result: cached }
      : source === "local"
        ? { source, nativeBuildId: null, result: cached }
        : null;
  return {
    key: { key: KEY, components: {} as never, uncacheable: null },
    slot: "/project/node_modules/.hot-updater/native-build/ios/release",
    hit,
    report: { hit: source, key: KEY, uncacheable: null, changed },
    logHeader: [`Native build key  ${KEY}`],
    remember: vi.fn(async () => {
      events.push("remember");
    }),
  };
};

const lastJson = () =>
  JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  installPods = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("native-build ios|android with a cached build", () => {
  it("builds on a miss, and tracks and caches the build with its key", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(
      cacheOf(null, ["file:src/App.tsx"]),
    );

    await handleNativeBuildCreate("ios", { scheme: "release", json: true });

    expect(events).toEqual([
      "build",
      "remember",
      "register",
      "remember tracked",
    ]);
    expect(registerNativeBuild).toHaveBeenCalledWith(built, { buildKey: KEY });
    expect(lastJson()).toMatchObject({
      build: built,
      nativeBuild: row,
      cache: {
        hit: null,
        key: KEY,
        uncacheable: null,
        changed: ["file:src/App.tsx"],
      },
    });
  });

  it("installs a scheme's pods before the key, which then holds what they resolved to, and builds with them", async () => {
    installPods = true;
    vi.mocked(reuseNativeBuild).mockImplementationOnce(async () => {
      events.push("key");
      return cacheOf(null);
    });

    await handleNativeBuildCreate("ios", { scheme: "release" });

    expect(events).toEqual([
      "pod install",
      "key",
      "build",
      "remember",
      "register",
      "remember tracked",
    ]);
    expect(installPodsIfNeeded).toHaveBeenCalledExactlyOnceWith("/project/ios");
    // The key reads the scheme as it is set; the build doesn't install again.
    expect(reuseNativeBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        iosScheme: expect.objectContaining({ installPods: true }),
      }),
    );
    expect(buildIos).toHaveBeenCalledWith(
      expect.objectContaining({
        schemeConfig: expect.objectContaining({ installPods: false }),
      }),
    );
  });

  it("installs pods for a reused build too, since its key needs them", async () => {
    installPods = true;
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf("storage"));

    await handleNativeBuildCreate("ios", { scheme: "release" });

    expect(events).toEqual(["pod install"]);
    expect(buildIos).not.toHaveBeenCalled();
  });

  it("installs no pods for a scheme without installPods", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf(null));

    await handleNativeBuildCreate("ios", { scheme: "release" });

    expect(installPodsIfNeeded).not.toHaveBeenCalled();
  });

  it("reuses a tracked build from storage: no build, no tracking, no upload", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf("storage"));

    await handleNativeBuildCreate("ios", { scheme: "release", json: true });

    expect(events).toEqual([]);
    expect(registerNativeBuild).not.toHaveBeenCalled();
    expect(rememberTrackedBuild).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({
      build: cached,
      nativeBuild: tracked,
      registration: { skipped: null },
      cache: { hit: "storage", key: KEY },
    });
  });

  it("tracks this machine's cached build, with the MIN_BUNDLE_ID it was built with, without building", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf("local"));

    await handleNativeBuildCreate("ios", { scheme: "release", json: true });

    expect(events).toEqual(["register", "remember tracked"]);
    expect(registerNativeBuild).toHaveBeenCalledWith(cached, {
      buildKey: KEY,
    });
    expect(lastJson()).toMatchObject({
      build: { minBundleId: cached.minBundleId },
      cache: { hit: "local" },
    });
  });

  it("records nothing on a dry run, which still caches its build for the real run", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf(null));

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      dryRun: true,
      json: true,
    });

    expect(events).toEqual(["build", "remember"]);
    expect(lastJson()).toMatchObject({
      nativeBuild: null,
      registration: { skipped: "dry-run" },
    });
  });

  it("passes --no-cache on, and builds", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf(null));

    await handleNativeBuildCreate("ios", { scheme: "release", cache: false });

    expect(reuseNativeBuild).toHaveBeenCalledWith(
      expect.objectContaining({ noCache: true }),
    );
    expect(events).toEqual([
      "build",
      "remember",
      "register",
      "remember tracked",
    ]);
  });

  it("does not upload a reused build TestFlight already has", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf("storage"));

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
      json: true,
    });

    expect(events).toEqual(["find on TestFlight"]);
    expect(findTestFlightBuild).toHaveBeenCalledWith({
      ipaPath: cached.artifactPath,
      apiKey: ascApiKey,
    });
    expect(lastJson()).toMatchObject({
      submission: { destination: "testflight", skipped: "already-submitted" },
    });
  });

  it("uploads a reused build TestFlight does not have yet", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf("storage"));
    vi.mocked(findTestFlightBuild).mockImplementationOnce(async () => {
      events.push("find on TestFlight");
      return {
        found: false,
        testFlightUrl: "https://asc",
        shortVersion: "1.0.0",
        bundleVersion: "7",
      };
    });

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(events).toEqual(["find on TestFlight", "upload"]);
    expect(uploadToTestFlight).toHaveBeenCalledWith({
      ipaPath: cached.artifactPath,
      apiKey: ascApiKey,
    });
  });

  it("checks no store for a new build, whose build number is new", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf(null));

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(findTestFlightBuild).not.toHaveBeenCalled();
    expect(events).toEqual([
      "build",
      "remember",
      "register",
      "remember tracked",
      "upload",
    ]);
  });

  it("does not release a reused build Google Play's internal track already has", async () => {
    vi.mocked(reuseNativeBuild).mockResolvedValueOnce(cacheOf("storage"));

    await handleNativeBuildCreate("android", {
      scheme: "release",
      submit: "play-internal",
      json: true,
    });

    expect(events).toEqual(["find on Play"]);
    expect(lastJson()).toMatchObject({
      submission: {
        destination: "play-internal",
        skipped: "already-submitted",
      },
    });
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
