import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first build of a project whose `secrets` adapter is `envSecrets()`, which
 * can't store the key a sign-in issues: the key goes to its 0600 file, and
 * the same build signs and uploads with it from there. Only the sign-ins,
 * the native build, and the stores are stand-ins; the credential resolver
 * and the issued-key flow are the CLI's own.
 */

const P8 =
  "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49firstBuildKey01\n-----END PRIVATE KEY-----";
const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  client_email: "hot-updater-play@my-app.iam.gserviceaccount.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nMIIBfirstBuild\n-----END PRIVATE KEY-----",
});

const { log, uploads, scheme, cacheDir } = vi.hoisted(() => ({
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
    /** A write-only adapter, as GitHub Actions secrets outside a workflow. */
    writeOnly: false,
  },
  cacheDir: { path: "" },
}));

vi.mock("@hot-updater/apple-helper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/apple-helper")>()),
  assertTestFlightExportOptions: vi.fn(async () => {}),
  buildIos: vi.fn(),
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
  buildAndroid: vi.fn(),
  issuePlayServiceAccount: vi.fn(async () => ({
    json: SERVICE_ACCOUNT,
    email: "hot-updater-play@my-app.iam.gserviceaccount.com",
    projectId: "my-app",
    developerId: "1234",
    keyId: "abc123",
    revoke: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
  })),
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
      message.includes("developer account")
        ? "1234"
        : message.includes("package name")
          ? "com.example.app"
          : "dev@example.com",
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
  const { envSecrets } = await import("@hot-updater/cli-tools");
  return {
    prepareNativeBuild: vi.fn(async (options) => {
      const secrets = scheme.writeOnly
        ? {
            name: "write-only",
            get: async (names: readonly string[]) =>
              Object.fromEntries(names.map((name) => [name, undefined])),
            set: async () => {},
          }
        : envSecrets();
      if (scheme.platform === "ios") {
        await options.beforePrebuild?.({
          scheme: "release",
          secrets,
          cacheDir: cacheDir.path,
          iosScheme: {
            configuration: "Release",
            bundleIdentifier: "com.example.app",
          },
        });
      } else {
        await options.beforePrebuild?.({
          scheme: "release",
          secrets,
          cacheDir: cacheDir.path,
          androidScheme: { packageName: "com.example.app" },
        });
      }
      return {
        buildAdapter: { name: "bare" },
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
vi.mock("@/utils/native/registerNativeBuild", () => ({
  registerNativeBuild: vi.fn(),
}));

import { buildAndroidNative, buildIosNative } from "./buildNative";

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
  scheme.writeOnly = false;
  cacheDir.path = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-build-"),
  );
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
  await fs.rm(cacheDir.path, { recursive: true, force: true });
});

describe("a first build whose secrets adapter is envSecrets()", () => {
  it("uploads to TestFlight with the key the sign-in issued, from its file", async () => {
    scheme.platform = "ios";
    await withTTY(() =>
      buildIosNative({
        interactive: false,
        scheme: "release",
        upload: "testflight",
      }),
    );

    expect(uploads).toEqual([{ keyId: "KEY1234567", p8: P8 }]);
    const file = path.join(cacheDir.path, "issued", "asc-api-key.json");
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toMatchObject({
      keyId: "KEY1234567",
      p8: P8,
    });
    expect(printed()).toContain(file);
    expect(printed()).not.toContain("MIGHAgEA");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("uploads to TestFlight with the key a write-only adapter stored, from its copy", async () => {
    scheme.platform = "ios";
    scheme.writeOnly = true;
    await withTTY(() =>
      buildIosNative({
        interactive: false,
        scheme: "release",
        upload: "testflight",
      }),
    );

    expect(uploads).toEqual([{ keyId: "KEY1234567", p8: P8 }]);
    expect(printed()).toContain("copied to a file");
    expect(printed()).not.toContain("MIGHAgEA");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("uploads to Google Play with the service account a write-only adapter stored, from its copy", async () => {
    scheme.platform = "android";
    scheme.writeOnly = true;
    await withTTY(() =>
      buildAndroidNative({
        interactive: false,
        scheme: "release",
        upload: "play-internal",
      }),
    );

    expect(uploads).toEqual([{ json: SERVICE_ACCOUNT }]);
    expect(printed()).not.toContain("MIIBfirstBuild");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("uploads to Google Play with the service account the sign-in issued, from its file", async () => {
    scheme.platform = "android";
    await withTTY(() =>
      buildAndroidNative({
        interactive: false,
        scheme: "release",
        upload: "play-internal",
      }),
    );

    expect(uploads).toEqual([{ json: SERVICE_ACCOUNT }]);
    const file = path.join(
      cacheDir.path,
      "issued",
      "play-service-account.json",
    );
    await expect(fs.readFile(file, "utf-8")).resolves.toBe(SERVICE_ACCOUNT);
    expect(printed()).not.toContain("MIIBfirstBuild");
    expect(log.error).not.toHaveBeenCalled();
  });
});
