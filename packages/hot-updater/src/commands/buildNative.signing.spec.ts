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
  p: {
    log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
  },
  withCredentialResolver: vi.fn(async (run) =>
    run({ resolve, dispose: vi.fn() }),
  ),
}));
// Issuing a missing key is ascApiKey.spec's; here the secrets adapter holds it.
vi.mock("../utils/native/ascApiKey", () => ({
  ensureAscApiKey: vi.fn(async ({ name }: { name: string }) => {
    events.push(`ensure asc-api-key ${name}`);
    return { status: "stored" };
  }),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("../utils/native/nativeBuildScope", () => ({
  resolveNativeBuildScope: vi.fn(async () => ({
    platform: "ios",
    channel: "production",
    fingerprintHash: "fp",
    appVersion: null,
  })),
}));
vi.mock("@/utils/native/registerNativeBuild", () => ({
  // The tracking preflight passes: its own specs cover it.
  preflightNativeBuildRegistration: vi.fn(async () => {}),
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

import {
  CredentialUnavailableError,
  p,
  setConfiguredSecrets,
  withCredentialResolver,
  withLocalKeyStore,
} from "@hot-updater/cli-tools";

import { ensureAscApiKey } from "../utils/native/ascApiKey";
import { handleNativeBuildCreate } from "./buildNative";

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
});

describe("native-build ios|android resolves its signing credentials before the prebuild", () => {
  it("resolves a release variant's keystore first", async () => {
    prebuildScheme.current = {
      androidScheme: {
        packageName: "com.example.app",
        signing: { keystore: "secret:release-keystore" },
      },
    };

    await handleNativeBuildCreate("android", {
      scheme: "release",
    });

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
        signing: { keystore: "secret:release-keystore" },
      },
    };

    await handleNativeBuildCreate("android", {
      scheme: "release",
    });

    expect(events).toEqual(["prebuild", "build"]);
  });

  it("resolves an iOS device build's App Store Connect API key first", async () => {
    prebuildScheme.current = {
      iosScheme: {
        bundleIdentifier: "com.example.app",
        signing: { ascApiKey: "secret:widget-asc" },
      },
    };

    await handleNativeBuildCreate("ios", {
      scheme: "release",
    });

    expect(events).toEqual([
      "ensure asc-api-key widget-asc",
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
        signing: { ascApiKey: "secret:widget-asc" },
      },
    };

    await handleNativeBuildCreate("ios", {
      scheme: "release",
    });

    expect(events).toEqual(["prebuild", "build"]);
  });

  it("fails before the prebuild when the secrets adapter lacks the keystore", async () => {
    prebuildScheme.current = {
      androidScheme: {
        packageName: "com.example.app",
        signing: { keystore: "secret:release-keystore" },
      },
    };
    resolve.mockImplementationOnce(async (request) => {
      events.push(`resolve ${request.kind} ${request.name}`);
      throw new CredentialUnavailableError(
        "android-keystore",
        "release-keystore (android-keystore) is not in the localSecrets secrets adapter.",
      );
    });
    vi.spyOn(process, "exit").mockImplementation((() => {
      events.push("exit");
      throw new Error("exit");
    }) as never);

    await expect(
      handleNativeBuildCreate("android", {
        scheme: "release",
      }),
    ).rejects.toThrow("exit");

    expect(events).toEqual([
      "resolve android-keystore release-keystore",
      "exit",
    ]);
    expect(p.log.error).toHaveBeenCalledWith(
      "release-keystore (android-keystore) is not in the localSecrets secrets adapter.",
    );
  });

  it("resolves from the prepared config's secrets adapter, whatever config loads after it", async () => {
    // Given: the platform config's adapter, and a later load, such as the
    // fingerprint's loadConfig(null), registering another
    const own = { name: "platform-store", get: vi.fn() };
    prebuildScheme.current = {
      secrets: own,
      iosScheme: {
        bundleIdentifier: "com.example.app",
        signing: { ascApiKey: "secret:widget-asc" },
      },
    };
    vi.mocked(ensureAscApiKey).mockImplementationOnce(async () => {
      setConfiguredSecrets({ name: "later-load", get: vi.fn() });
      return { status: "stored" };
    });

    try {
      await handleNativeBuildCreate("ios", {
        scheme: "release",
      });

      // Then: the sign-in preflight and the resolver use the config's own
      const [, options] = vi.mocked(withCredentialResolver).mock.calls[0]!;
      const secrets = options?.secrets;
      expect(typeof secrets === "function" ? secrets() : secrets).toBe(own);
      expect(ensureAscApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ name: "widget-asc", secrets: own }),
      );
    } finally {
      setConfiguredSecrets(withLocalKeyStore());
    }
  });
});
