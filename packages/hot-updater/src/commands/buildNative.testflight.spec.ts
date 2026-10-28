import { stripVTControlCharacters } from "node:util";

import type { EnrichedNativeBuildIosScheme } from "@hot-updater/apple-helper";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@hot-updater/apple-helper", () => ({
  TestFlightBuildExistsError: class TestFlightBuildExistsError extends Error {},
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
  resolveTestFlightUploadKey,
  uploadToTestFlight,
} from "@hot-updater/apple-helper";
import { p } from "@hot-updater/cli-tools";

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
      signing: { ascApiKey: "secret:widget-asc" },
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
      { simulator: true, signing: { ascApiKey: "secret:asc-api-key" } },
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
    const summary = stripVTControlCharacters(
      String(vi.mocked(p.log.step).mock.calls[0]?.[0]),
    );
    expect(summary).toContain("Dry run: nothing was recorded or submitted");
    expect(summary).toContain("/out/export/App.ipa");
    expect(summary).toContain("0190a1b2-c3d4-7000-8000-01a1b2c3d4e5");
    expect(summary).toContain("the native build and its built-in bundle");
    expect(summary).toContain("to TestFlight");
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

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
