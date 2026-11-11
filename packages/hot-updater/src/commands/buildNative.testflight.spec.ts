import { stripVTControlCharacters } from "node:util";

import type { EnrichedNativeBuildIosScheme } from "@hot-updater/apple-helper";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
/** The scheme the config sets, as beforePrebuild receives it. */
let iosScheme: Record<string, unknown> = { configuration: "Release" };
/** Why the secrets adapter has no item, when a test makes it miss one. */
let missingItem: string | undefined;

const ascApiKey = {
  keyPath: "/tmp/AuthKey_ABC.p8",
  keyId: "ABC",
  issuerId: "issuer",
};

const TESTFLIGHT_URL =
  "https://appstoreconnect.apple.com/apps/123/testflight/ios";

/** An upload App Store Connect hadn't accepted when the wait ended. */
const STILL_PROCESSING = {
  appId: "123",
  buildUploadId: "upload-1",
  state: "PROCESSING",
  testFlightUrl: TESTFLIGHT_URL,
  shortVersion: "1.7.0",
  bundleVersion: "66",
} as const;

/** What App Store Connect answers for the build, in `state`. */
const buildStatus = (state: string) => ({
  testFlightUrl: TESTFLIGHT_URL,
  status: {
    buildId: "build-1",
    audience: "ALL_USERS",
    state,
    expiresAtMs: null,
  },
});

vi.mock("@hot-updater/apple-helper", () => ({
  // An ad hoc export runs the device registry step; these specs build none.
  exportsForRegisteredDevices: vi.fn(async () => false),
  TestFlightBuildExistsError: class TestFlightBuildExistsError extends Error {},
  assertTestFlightExportOptions: vi.fn(async () => {
    events.push("check export options");
  }),
  buildIos: vi.fn(async () => ({ logFilePath: null })),
  readIpaHasExportComplianceKey: vi.fn(async () => true),
  readTestFlightBuildStatus: vi.fn(async () => buildStatus("ready")),
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
      testFlightUrl: TESTFLIGHT_URL,
      shortVersion: "1.7.0",
      bundleVersion: "66",
    };
  }),
}));
vi.mock("@hot-updater/android-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/android-helper")>()),
  buildAndroid: vi.fn(async () => ({ logFilePath: null })),
}));
vi.mock("../utils/native/ascApiKey", () => ({
  ensureAscApiKey: vi.fn(async ({ name }: { name: string }) => {
    events.push(`ensure ${name}`);
    return { status: "stored" };
  }),
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
  withCredentialResolver: vi.fn(async (run) => {
    const { CredentialUnavailableError } =
      await import("@hot-updater/cli-tools");
    try {
      return await run({
        resolve: vi.fn(async (request) => {
          events.push(`resolve ${request.name}`);
          if (missingItem !== undefined) {
            throw new CredentialUnavailableError(request.kind, missingItem);
          }
          return ascApiKey;
        }),
        dispose: vi.fn(),
      });
    } finally {
      events.push("dispose");
    }
  }),
}));
vi.mock("../utils/native/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/sandbox")>()),
  assertBuiltArtifact: vi.fn(async () => null),
}));
vi.mock("../utils/native/reportIpaDevices", () => ({
  reportIpaDevices: vi.fn(async () => {}),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", () => ({
  prepareNativeBuild: vi.fn(async (options) => {
    const iosSchemeConfig = {
      bundleIdentifier: "com.example.app",
      configuration: "Release",
      signing: { ascApiKey: secret("asc-api-key") },
    } as unknown as EnrichedNativeBuildIosScheme;
    await options.beforePrebuild?.({ scheme: "release", iosScheme });
    events.push("prebuild");
    return {
      buildAdapter: { name: "bare" },
      config: { cacheDir: null },
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
  NativeBuildUnreachableError: class extends Error {
    constructor(
      readonly what: string,
      readonly reason: string,
    ) {
      super(`${what}: ${reason}`);
    }
  },
  issueMinBundleId: vi.fn(async () => "019a0000-0000-7000-8000-000000000000"),
  isNativeBuildConflict: () => false,
  // The tracking preflight passes: its own specs cover what it checks.
  preflightNativeBuildRegistration: vi.fn(async () => {
    events.push("preflight");
  }),
  registerNativeBuild: vi.fn(async () => {
    events.push("register");
  }),
}));

import {
  readIpaHasExportComplianceKey,
  readTestFlightBuildStatus,
  resolveTestFlightUploadKey,
  uploadToTestFlight,
} from "@hot-updater/apple-helper";
import { p } from "@hot-updater/cli-tools";
import { secret } from "@hot-updater/cli-tools";

import { createNativeBuild } from "@/utils/native/createNativeBuild";
import {
  NativeBuildUnreachableError,
  preflightNativeBuildRegistration,
  registerNativeBuild,
} from "@/utils/native/registerNativeBuild";

import { ensureAscApiKey } from "../utils/native/ascApiKey";
import { CredentialSetupRefusedError } from "../utils/native/issuedCredential";
import { resolveNativeBuildScope } from "../utils/native/nativeBuildScope";
import { handleNativeBuildCreate } from "./buildNative";

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  missingItem = undefined;
  iosScheme = { configuration: "Release", bundleIdentifier: "com.example.app" };
});

const mockExit = () =>
  vi.spyOn(process, "exit").mockImplementation((() => {
    events.push("exit");
    throw new Error("exit");
  }) as never);

describe("native-build ios --submit testflight", () => {
  it("checks the scheme and resolves the key before the prebuild, then builds, registers and uploads", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(events).toEqual([
      "check scheme",
      // Before any sign-in, so a build that can't be tracked stops in seconds.
      "preflight",
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

  it("submits nothing without --submit, and tracks the build", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "release",
    });

    expect(events).toEqual([
      "preflight",
      "prebuild",
      "build",
      "register",
      "dispose",
    ]);
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
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
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
        "App Store Connect already has build 42 of version 1.2.0.\nUse a new build number (CFBundleVersion).",
      ),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    ).rejects.toThrow("exit");

    expect(p.log.error).toHaveBeenCalledWith(
      "App Store Connect already has build 42 of version 1.2.0.\nUse a new build number (CFBundleVersion).\nThe build stays at /out/export/App.ipa.",
    );
    // The resolver deletes its temporary files before the process exits.
    expect(events.slice(-2)).toEqual(["dispose", "exit"]);
    exit.mockRestore();
  });
});

describe("the state of a build App Store Connect accepted", () => {
  const upload = async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
      json: true,
    });
    const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    log.mockRestore();
    return printed.submission.store;
  };
  const warnings = () =>
    vi.mocked(p.log.warn).mock.calls.map(([message]) => message);

  it("says a build waits on export compliance, and carries the state in --json", async () => {
    vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce(
      buildStatus("missing-compliance") as never,
    );

    expect(await upload()).toEqual({
      destination: "testflight",
      url: TESTFLIGHT_URL,
      version: "1.7.0 (66)",
      state: "missing-compliance",
      expiresAtMs: null,
      reusable: true,
    });
    expect(warnings()).toEqual([
      [
        "Testers can't install 1.7.0 (66): it's waiting on export compliance.",
        "Answer it in App Store Connect:",
        TESTFLIGHT_URL,
        "Or set ITSAppUsesNonExemptEncryption in Info.plist for later builds.",
      ].join("\n"),
    ]);
    expect(process.exitCode).toBeFalsy();
  });

  it("reads the state once, for the version and number it uploaded", async () => {
    await upload();

    expect(readTestFlightBuildStatus).toHaveBeenCalledTimes(1);
    expect(readTestFlightBuildStatus).toHaveBeenCalledWith({
      bundleId: "com.example.app",
      shortVersion: "1.7.0",
      bundleVersion: "66",
      apiKey: ascApiKey,
    });
  });

  it.each(["ready", "processing"])(
    "says nothing of a build that is %s",
    async (state) => {
      vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce(
        buildStatus(state) as never,
      );

      expect(await upload()).toMatchObject({ state });
      expect(warnings()).toEqual([]);
    },
  );

  it("counts a build App Store Connect doesn't list yet as processing", async () => {
    vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce({
      testFlightUrl: TESTFLIGHT_URL,
      status: null,
    });

    expect(await upload()).toMatchObject({
      state: "processing",
      reusable: true,
    });
    expect(warnings()).toEqual([]);
  });

  it("still succeeds when the state can't be read, with no state in --json", async () => {
    vi.mocked(readTestFlightBuildStatus).mockRejectedValueOnce(
      new Error("App Store Connect answered 500."),
    );

    expect(await upload()).toEqual({
      destination: "testflight",
      url: TESTFLIGHT_URL,
      version: "1.7.0 (66)",
      state: null,
      expiresAtMs: null,
      reusable: true,
    });
    expect(warnings()).toEqual([
      "Couldn't read the build's state from App Store Connect.\nApp Store Connect answered 500.",
    ]);
    expect(process.exitCode).toBeFalsy();
  });

  it("reads nothing for a build App Store Connect is still processing after the wait", async () => {
    vi.mocked(uploadToTestFlight).mockResolvedValueOnce(STILL_PROCESSING);

    expect(await upload()).toBeNull();
    expect(readTestFlightBuildStatus).not.toHaveBeenCalled();
  });

  describe("while App Store Connect processes it", () => {
    const EXPECTED = [
      "1.7.0 (66) is processing. Without ITSAppUsesNonExemptEncryption in Info.plist, testers can't install it until export compliance is answered in App Store Connect:",
      TESTFLIGHT_URL,
    ].join("\n");

    it("says what to expect of an .ipa without the key, keeping the state", async () => {
      vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce(
        buildStatus("processing") as never,
      );
      vi.mocked(readIpaHasExportComplianceKey).mockResolvedValueOnce(false);

      expect(await upload()).toMatchObject({ state: "processing" });
      expect(readIpaHasExportComplianceKey).toHaveBeenCalledWith(
        "/out/export/App.ipa",
      );
      expect(warnings()).toEqual([EXPECTED]);
      expect(process.exitCode).toBeFalsy();
    });

    it("says it of a build App Store Connect doesn't list yet", async () => {
      vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce({
        testFlightUrl: TESTFLIGHT_URL,
        status: null,
      });
      vi.mocked(readIpaHasExportComplianceKey).mockResolvedValueOnce(false);

      await upload();

      expect(warnings()).toEqual([EXPECTED]);
    });

    it("says it of a build still processing after the wait, reading no state", async () => {
      vi.mocked(uploadToTestFlight).mockResolvedValueOnce(STILL_PROCESSING);
      vi.mocked(readIpaHasExportComplianceKey).mockResolvedValueOnce(false);

      await upload();

      expect(readTestFlightBuildStatus).not.toHaveBeenCalled();
      expect(warnings()).toEqual([EXPECTED]);
    });

    it("says nothing new of an .ipa with the key", async () => {
      vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce(
        buildStatus("processing") as never,
      );
      vi.mocked(readIpaHasExportComplianceKey).mockResolvedValueOnce(true);

      await upload();

      expect(readIpaHasExportComplianceKey).toHaveBeenCalledTimes(1);
      expect(warnings()).toEqual([]);
    });

    it("says nothing, and fails nothing, when the .ipa can't be read", async () => {
      vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce(
        buildStatus("processing") as never,
      );
      vi.mocked(readIpaHasExportComplianceKey).mockRejectedValueOnce(
        new Error("unzip failed"),
      );

      expect(await upload()).toMatchObject({ state: "processing" });
      expect(warnings()).toEqual([]);
      expect(process.exitCode).toBeFalsy();
    });

    it("reads the state once, and never polls", async () => {
      vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce(
        buildStatus("processing") as never,
      );

      await upload();

      expect(readTestFlightBuildStatus).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["ready", "failed", "expired"])(
    "reads no .ipa for a build that is %s",
    async (state) => {
      vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce(
        buildStatus(state) as never,
      );

      await upload();

      expect(readIpaHasExportComplianceKey).not.toHaveBeenCalled();
      expect(warnings()).toEqual([]);
    },
  );

  it("keeps to the failed read's warning when the state can't be read", async () => {
    vi.mocked(readTestFlightBuildStatus).mockRejectedValueOnce(
      new Error("App Store Connect answered 500."),
    );
    vi.mocked(readIpaHasExportComplianceKey).mockResolvedValueOnce(false);

    await upload();

    expect(warnings()).toEqual([
      "Couldn't read the build's state from App Store Connect.\nApp Store Connect answered 500.",
    ]);
  });

  it("asks nothing of a build waiting on the answer, whatever the .ipa holds", async () => {
    vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce(
      buildStatus("missing-compliance") as never,
    );
    vi.mocked(readIpaHasExportComplianceKey).mockResolvedValueOnce(true);

    await upload();

    expect(readIpaHasExportComplianceKey).not.toHaveBeenCalled();
    expect(warnings()).toHaveLength(1);
  });

  it("says Apple is reviewing a build in export compliance review, and asks for no answer", async () => {
    vi.mocked(readTestFlightBuildStatus).mockResolvedValueOnce({
      testFlightUrl: TESTFLIGHT_URL,
      status: {
        buildId: "build-1",
        audience: "ALL_USERS",
        state: "missing-compliance",
        inExportComplianceReview: true,
        expiresAtMs: null,
      },
    } as never);

    expect(await upload()).toEqual({
      destination: "testflight",
      url: TESTFLIGHT_URL,
      version: "1.7.0 (66)",
      state: "missing-compliance",
      expiresAtMs: null,
      reusable: true,
    });
    expect(warnings()).toEqual([
      `Testers can't install 1.7.0 (66) yet: Apple is reviewing its export compliance.\n${TESTFLIGHT_URL}`,
    ]);
    expect(String(warnings()[0])).not.toMatch(/answer/iu);
  });
});

describe("native-build ios without an App Store Connect API key", () => {
  it("issues the key before the prebuild", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
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
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
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
      new Error("The spec-store secrets adapter could not be reached."),
    );
    const exit = mockExit();
    await expect(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    ).rejects.toThrow("exit");
    expect(p.log.error).toHaveBeenCalledWith(
      "The spec-store secrets adapter could not be reached.",
    );
    expect(events).not.toContain("prebuild");
    exit.mockRestore();
  });

  it("issues the key a device build signs with, by the name signing.ascApiKey sets", async () => {
    iosScheme = {
      configuration: "Release",
      bundleIdentifier: "com.example.widget",
      signing: { ascApiKey: secret("widget-asc") },
    };
    await handleNativeBuildCreate("ios", {
      scheme: "release",
    });
    expect(ensureAscApiKey).toHaveBeenCalledWith({ name: "widget-asc" });
    // The signing key resolves before the prebuild, with the build's others.
    expect(events).toEqual([
      "preflight",
      "ensure widget-asc",
      "resolve widget-asc",
      "prebuild",
      "build",
      "register",
      "dispose",
    ]);
  });

  it.each([
    [
      "a simulator build",
      { simulator: true, signing: { ascApiKey: secret("asc-api-key") } },
    ],
    [
      "a scheme that signs with exportOptionsPlist",
      { exportOptionsPlist: "export.plist" },
    ],
  ])("needs no key for %s", async (_, scheme) => {
    iosScheme = { configuration: "Release", ...scheme };
    await handleNativeBuildCreate("ios", {
      scheme: "release",
    });
    expect(ensureAscApiKey).not.toHaveBeenCalled();
  });
});

describe("native-build ios tracking", () => {
  it("stops before any sign-in or build when the build can't be tracked, naming what it can't reach", async () => {
    vi.mocked(preflightNativeBuildRegistration).mockRejectedValueOnce(
      new NativeBuildUnreachableError(
        "the native build registry",
        "connection refused",
      ),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    ).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(events).toEqual(["check scheme", "dispose", "exit"]);
    expect(ensureAscApiKey).not.toHaveBeenCalled();
    expect(createNativeBuild).not.toHaveBeenCalled();
    expect(p.log.error).toHaveBeenCalledWith(
      "Can't reach the native build registry. Nothing was built.\nconnection refused\nCheck the database and storage in hot-updater.config.ts.",
    );
  });

  it("checks the registry without a scope when the native project is not generated yet, and builds", async () => {
    vi.mocked(resolveNativeBuildScope).mockRejectedValueOnce(
      new Error("ios/HotUpdaterExample/Info.plist does not exist"),
    );

    await handleNativeBuildCreate("ios", { scheme: "release" });

    expect(preflightNativeBuildRegistration).toHaveBeenCalledWith(null);
    expect(events).toEqual([
      "preflight",
      "prebuild",
      "build",
      "register",
      "dispose",
    ]);
    expect(p.log.error).not.toHaveBeenCalled();
  });

  it("tracks no Debug build, saying so before the build, without the preflight", async () => {
    iosScheme = { configuration: "Debug", bundleIdentifier: "com.example.app" };

    await handleNativeBuildCreate("ios", { scheme: "release" });

    expect(events).toEqual(["prebuild", "build", "dispose"]);
    expect(preflightNativeBuildRegistration).not.toHaveBeenCalled();
    expect(registerNativeBuild).not.toHaveBeenCalled();
    expect(p.log.info).toHaveBeenCalledWith(
      "Not tracking release: a Debug build has no built-in bundle.",
    );
  });

  it("prints why a Debug build has no record in --json", async () => {
    iosScheme = { configuration: "Debug", bundleIdentifier: "com.example.app" };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleNativeBuildCreate("ios", { scheme: "release", json: true });

    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      nativeBuild: null,
      registration: { skipped: "debug" },
    });
    log.mockRestore();
  });

  it("submits nothing when tracking fails after the build, naming the artifact's path", async () => {
    vi.mocked(registerNativeBuild).mockRejectedValueOnce(
      new Error("storage refused the artifact"),
    );
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    ).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(uploadToTestFlight).not.toHaveBeenCalled();
    expect(events).not.toContain("upload");
    expect(p.log.error).toHaveBeenCalledWith(
      "Couldn't track the native build.\nstorage refused the artifact\nNot submitted to TestFlight.\nThe build stays at /out/export/App.ipa.",
    );
  });
});

describe("native-build ios --dry-run", () => {
  it("builds and checks read-only, never signing in, recording, or submitting", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
      dryRun: true,
      json: true,
    });

    expect(events).toEqual([
      "check scheme",
      "preflight",
      "resolve asc-api-key",
      "prebuild",
      "check export options",
      "build",
      "dispose",
    ]);
    // Nothing that writes: no sign-in that issues a key, no record, no upload.
    expect(ensureAscApiKey).not.toHaveBeenCalled();
    expect(registerNativeBuild).not.toHaveBeenCalled();
    expect(uploadToTestFlight).not.toHaveBeenCalled();
    // The summary names the artifact; the dry run adds one line.
    const built = stripVTControlCharacters(
      vi.mocked(p.log.success).mock.calls.map(String).join("\n"),
    );
    expect(built).toMatch(/^iOS release built in \d+\.\ds\n/);
    expect(built).toContain("/out/export/App.ipa");
    expect(built).toContain("0190a1b2-c3d4-7000-8000-01a1b2c3d4e5");
    expect(vi.mocked(p.log.step).mock.calls).toEqual([
      ["Dry run: not recorded or submitted to TestFlight"],
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      dryRun: true,
      nativeBuild: null,
      registration: { skipped: "dry-run" },
      submission: { destination: "testflight", skipped: "dry-run" },
    });
    log.mockRestore();
  });

  it("still builds without the store key, reports it, and fails at the end", async () => {
    missingItem = "asc-api-key is not in the envSecrets secrets adapter.";
    const exit = mockExit();

    await expect(
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
        dryRun: true,
      }),
    ).rejects.toThrow("exit");

    expect(events).toContain("build");
    expect(ensureAscApiKey).not.toHaveBeenCalled();
    expect(uploadToTestFlight).not.toHaveBeenCalled();
    expect(vi.mocked(p.log.step)).toHaveBeenCalledTimes(1);
    expect(p.log.error).toHaveBeenCalledWith(
      "A real run couldn't submit to TestFlight.\nasc-api-key is not in the envSecrets secrets adapter.",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("tracks and submits as usual without --dry-run", async () => {
    await handleNativeBuildCreate("ios", {
      scheme: "release",
      submit: "testflight",
    });

    expect(events).toContain("register");
    expect(events).toContain("upload");
    expect(p.log.message).not.toHaveBeenCalled();
  });
});
