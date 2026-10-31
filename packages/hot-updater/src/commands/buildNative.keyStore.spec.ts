import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first build of a project without a `secrets` adapter: the key a
 * sign-in issues goes to `localSecrets()`'s store, the same build signs and
 * uploads with it, and the next build on this machine reuses it without
 * signing in. A configured adapter is the only store: one that doesn't read
 * back the key leaves nothing on this machine. Only the sign-ins, the native build, and the stores are
 * stand-ins; the credential resolver and the issued-key flow are the CLI's
 * own.
 */

const P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49firstBuildKey01\n-----END PRIVATE KEY-----";
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "hot-updater-play@my-app.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIBfirstBuild\n-----END PRIVATE KEY-----",
});

const { log, uploads, scheme, home } = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  /** What each store upload was given, read while the upload runs. */
  uploads: [] as unknown[],
  scheme: {
    platform: "ios" as "ios" | "android",
    /**
     * The config's adapter: none (`localSecrets()`), or one that stores but
     * reads nothing back.
     */
    adapter: "none" as "none" | "writeOnly",
  },
  home: { path: "" },
}));

vi.mock("@hot-updater/apple-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/apple-helper")>()),
  assertTestFlightExportOptions: vi.fn(async () => {}),
  buildIos: vi.fn(async () => ({ logFilePath: null })),
  issueAscApiKey: vi.fn(async (request: { name: string }) => ({
    p8: P8,
    keyId: "KEY1234567",
    issuerId: "issuer-1",
    name: request.name,
    team: {},
    revoke: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
  })),
  resolveTestFlightUploadKey: vi.fn(() => ({
    kind: "asc-api-key",
    name: "asc-api-key",
  })),
  uploadToTestFlight: vi.fn(
    async ({ apiKey }: { apiKey: { keyPath: string; keyId: string } }) => {
      uploads.push({
        keyId: apiKey.keyId,
        p8: await fs.readFile(apiKey.keyPath, "utf-8"),
      });
      return { state: "COMPLETE", testFlightUrl: "https://example.com" };
    },
  ),
}));
vi.mock("@hot-updater/android-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/android-helper")>()),
  buildAndroid: vi.fn(async () => ({ logFilePath: null })),
  checkPlayAccess: vi.fn(async () => ({ status: "ready" })),
  readBuiltPackageName: vi.fn(async () => "com.example.app"),
  resolvePlayUploadServiceAccount: vi.fn(() => ({
    kind: "play-service-account",
    name: "play-service-account",
  })),
  uploadToPlay: vi.fn(
    async ({ serviceAccount }: { serviceAccount: unknown }) => {
      uploads.push(serviceAccount);
      return { versionCode: 42, status: "completed" };
    },
  ),
}));
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: {
    log,
    isCancel: vi.fn(() => false),
    text: vi.fn(async ({ message }: { message: string }) =>
      message.includes("package name") ? "com.example.app" : "dev@example.com",
    ),
    select: vi.fn(async () => "my-app"),
  },
}));
vi.mock("open", () => ({ default: vi.fn(async () => {}) }));
// The GitHub Actions offer has its own specs: here it finds nothing to offer.
vi.mock("../utils/native/githubSecret", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/native/githubSecret")>()),
  offerGitHubSecret: vi.fn(async () => "unavailable"),
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("@/utils/setChannel", () => ({ getChannel: vi.fn() }));
vi.mock("@/utils/native/prepareNativeBuild", async () => {
  const { resolveSecretsAdapter } = await import("@hot-updater/cli-tools");
  return {
    prepareNativeBuild: vi.fn(async (options) => {
      const get = async (names: readonly string[]) =>
        Object.fromEntries(names.map((name) => [name, undefined]));
      const configured =
        scheme.adapter === "writeOnly"
          ? { name: "write-only", get, set: async () => {} }
          : undefined;
      // As loadConfig hands it over: `localSecrets()` without an adapter.
      const secrets = resolveSecretsAdapter(configured);
      if (scheme.platform === "ios") {
        await options.beforePrebuild?.({
          scheme: "release",
          secrets,
          iosScheme: {
            configuration: "Release",
            bundleIdentifier: "com.example.app",
          },
        });
      } else {
        await options.beforePrebuild?.({
          scheme: "release",
          secrets,
          androidScheme: { packageName: "com.example.app" },
        });
      }
      return {
        buildAdapter: { name: "bare" },
        config: { cacheDir: null },
        outputPath: "/out",
        scheme: "release",
        target: { fingerprintHash: "fp", appVersion: null },
        iosSchemeConfig: { configuration: "Release" },
        androidSchemeConfig: { variant: "release", applicationId: "x" },
      };
    }),
  };
});
vi.mock("@/utils/native/createNativeBuild", () => ({
  createNativeBuild: vi.fn(async () => ({
    platform: scheme.platform,
    scheme: "release",
    minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
    channel: "production",
    fingerprintHash: "fp",
    appVersion: null,
    artifactPath: "/out/App",
    artifactKind: scheme.platform === "ios" ? "ipa" : "aab",
  })),
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
  registerNativeBuild: vi.fn(),
}));

import { checkPlayAccess } from "@hot-updater/android-helper";
import { issueAscApiKey } from "@hot-updater/apple-helper";
import {
  getCwd,
  getLocalKeyFile,
  resolveSecretsAdapter,
} from "@hot-updater/cli-tools";

import { handleNativeBuildCreate } from "./buildNative";

const withTTY = async <T>(run: () => Promise<T>) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
};

const printed = () =>
  Object.values(log)
    .flatMap((fn) => fn.mock.calls.flat())
    .map(String)
    .join("\n");

beforeEach(async () => {
  vi.clearAllMocks();
  uploads.length = 0;
  scheme.adapter = "none";
  home.path = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-build-"));
  vi.stubEnv("HOT_UPDATER_HOME", home.path);
  vi.stubEnv("CI", "");
  for (const name of [
    "HOT_UPDATER_ASC_KEY_PATH",
    "HOT_UPDATER_ASC_KEY",
    "HOT_UPDATER_ASC_KEY_ID",
    "HOT_UPDATER_ASC_ISSUER_ID",
    "HOT_UPDATER_ASC_API_KEY",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    "HOT_UPDATER_PLAY_SERVICE_ACCOUNT",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home.path, { recursive: true, force: true });
});

const keyFile = (name: string) => getLocalKeyFile(name, getCwd());

describe("a first build without a secrets adapter", () => {
  it("uploads to TestFlight with the key the sign-in issued, keeps it on this machine, and the next build reuses it without signing in", async () => {
    scheme.platform = "ios";
    const build = () =>
      withTTY(() =>
        handleNativeBuildCreate("ios", {
          scheme: "release",
          submit: "testflight",
        }),
      );
    await build();

    expect(uploads).toEqual([{ keyId: "KEY1234567", p8: P8 }]);
    const file = keyFile("asc-api-key");
    expect(file.startsWith(home.path)).toBe(true);
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({
      keyId: "KEY1234567",
      p8: P8,
    });
    expect(printed()).toContain(path.basename(file));
    expect(printed()).toContain(
      "No App Store Connect API key on this machine: signing in issues one.",
    );
    expect(printed()).not.toContain("MIGHAgEA");
    expect(log.error).not.toHaveBeenCalled();

    vi.clearAllMocks();
    uploads.length = 0;
    await build();

    expect(issueAscApiKey).not.toHaveBeenCalled();
    expect(uploads).toEqual([{ keyId: "KEY1234567", p8: P8 }]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("revokes the key a write-only adapter doesn't read back, builds nothing, and copies it nowhere", async () => {
    scheme.platform = "ios";
    scheme.adapter = "writeOnly";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await withTTY(() =>
      handleNativeBuildCreate("ios", {
        scheme: "release",
        submit: "testflight",
      }),
    ).catch(() => undefined);

    expect(uploads).toEqual([]);
    expect(stripVTControlCharacters(printed())).toContain(
      [
        "Couldn't store the App Store Connect API key KEY1234567, so it was revoked.",
        "The write-only secrets adapter reads back nothing for asc-api-key.",
      ].join("\n"),
    );
    expect(printed()).not.toContain("copied to this machine");
    expect(printed()).not.toContain("MIGHAgEA");
    await expect(fs.readdir(home.path)).resolves.toEqual([]);
    exit.mockRestore();
  });

  it("creates no Play key: it names the command, then uploads with the key secrets put stored", async () => {
    scheme.platform = "android";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const build = () =>
      withTTY(() =>
        handleNativeBuildCreate("android", {
          scheme: "release",
          submit: "play-internal",
        }),
      );
    await expect(build()).rejects.toThrow("exit");

    expect(uploads).toEqual([]);
    expect(stripVTControlCharacters(printed())).toContain(
      [
        "✗ Service account key",
        "  npx hot-updater secrets put play-service-account <key.json>",
      ].join("\n"),
    );
    expect(checkPlayAccess).not.toHaveBeenCalled();
    await expect(fs.readdir(home.path)).resolves.toEqual([]);
    exit.mockRestore();

    await resolveSecretsAdapter().set("play-service-account", SERVICE_ACCOUNT, {
      cwd: getCwd(),
    });
    vi.clearAllMocks();
    await build();

    expect(checkPlayAccess).toHaveBeenCalledTimes(1);
    expect(uploads).toEqual([{ json: SERVICE_ACCOUNT }]);
    expect(printed()).not.toContain("MIIBfirstBuild");
    expect(log.error).not.toHaveBeenCalled();
  });
});
