import fs from "fs/promises";
import crypto from "node:crypto";
import os from "os";
import path from "path";
import { stripVTControlCharacters } from "util";

import {
  assembleServer,
  getCwd,
  loadConfig,
  p,
  readPackageUp,
} from "@hot-updater/cli-tools";
import { secret } from "@hot-updater/cli-tools";
import {
  type ConfiguredDatabase,
  createMemoryAdapter,
} from "@hot-updater/plugin-core";
import { HOT_UPDATER_SERVER_VERSION } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { packageJsonData } from "../packageJson";
import {
  androidKeystoreValue,
  findKeytool,
} from "../utils/native/androidKeystore";
import {
  areVersionsCompatible,
  checkInfrastructureStatus,
  createInfrastructureRemediation,
  doctor,
  getRequiredInfrastructureVersion,
  getRequiredServerVersion,
  handleDoctor,
  isInfrastructureUpdateRequired,
  resolveVersionEndpoint,
} from "./doctor";
import { checkFingerprintJson } from "./doctor/fingerprint";
import type { NativeCheckIssue } from "./doctor/issues";
import { getRequiredUpdateTarget } from "./doctorInfrastructureTargets";

vi.mock("../packageJson", () => ({ packageJsonData: { version: "1.0.0" } }));

// The Play Developer API's own specs cover the edit; a spec answers it here.
const { checkPlayAccess } = vi.hoisted(() => ({ checkPlayAccess: vi.fn() }));
vi.mock("@hot-updater/android-helper", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@hot-updater/android-helper")>();
  return { ...original, checkPlayAccess };
});

/** The JDK's keytool, when this machine has one: CI's runners do. */
const realKeytool = await findKeytool().catch(() => undefined);

// Computing a fingerprint hashes the whole project; doctor/fingerprint.spec
// covers the comparison itself.
vi.mock("./doctor/fingerprint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor/fingerprint")>()),
  checkFingerprintJson: vi.fn(async () => []),
}));

vi.mock("../utils/version/getNativeAppVersion", () => ({
  getNativeAppVersion: vi.fn(async (platform: "ios" | "android") =>
    platform === "ios" ? "1.2.3" : "1.2.4",
  ),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  // The server doctor reads is assembled from the config as the CLI does.
  assembleServer: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).assembleServer,
  colors: (await importOriginal<typeof import("@hot-updater/cli-tools")>())
    .colors,
  nonInteractiveReason: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).nonInteractiveReason,
  getBundleSigningPublicKey: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).getBundleSigningPublicKey,
  // The secrets check reads the environment and the adapter as the CLI does.
  ...(({
    bundleSigningPutCommand,
    CREDENTIAL_ENV_NAMES,
    credentialPutCommand,
    credentialStoreCommand,
    describeMissingSecret,
    getConfiguredAdapter,
    getDeploySecretNames,
    getHotUpdaterEnvValue,
    isSecretRef,
    readLoadedHotUpdaterEnv,
    registerCredentialValue,
    secret,
    secretVariableName,
    withCredentialResolver,
  }) => ({
    bundleSigningPutCommand,
    CREDENTIAL_ENV_NAMES,
    credentialPutCommand,
    credentialStoreCommand,
    describeMissingSecret,
    getConfiguredAdapter,
    getDeploySecretNames,
    getHotUpdaterEnvValue,
    isSecretRef,
    readLoadedHotUpdaterEnv,
    registerCredentialValue,
    secret,
    secretVariableName,
    withCredentialResolver,
  }))(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  // The signing row says what deploy says.
  ...(({
    INVALID_SIGNING_NEXT_STEP,
    ISSUE_SIGNING_KEY_COMMAND,
    PUT_SIGNING_KEY_COMMAND,
    readBundleSigningState,
    UNSIGNED_BUNDLES_NEXT_STEP,
    UNSIGNED_BUNDLES_WARNING,
  }) => ({
    INVALID_SIGNING_NEXT_STEP,
    ISSUE_SIGNING_KEY_COMMAND,
    PUT_SIGNING_KEY_COMMAND,
    readBundleSigningState,
    UNSIGNED_BUNDLES_NEXT_STEP,
    UNSIGNED_BUNDLES_WARNING,
  }))(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(() => "/mock/cwd"),
  loadConfig: vi.fn(),
  p: {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    isCancel: vi.fn(() => false),
    text: vi.fn(),
    log: {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      message: vi.fn(),
      step: vi.fn(),
    },
  },
  readPackageUp: vi.fn(),
}));

/**
 * A healthy project's result when doctor was given no server URL and no
 * agent scaffold records one: it says the server's version went unchecked.
 */
const HEALTHY_WITHOUT_SERVER = {
  success: true,
  details: {
    infrastructureUnchecked: {
      message: expect.stringContaining("The server's version was not checked"),
      commands: ["npx hot-updater doctor --server-base-url <url>"],
    },
  },
};

/** A team secrets adapter that holds `values`. */
const holding = (values: Record<string, string>) => ({
  name: "team-store",
  get: async (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, values[name]])),
  set: async () => {},
});

/** The row of a config without `signing`: what deploy warns. */
const UNSIGNED_SIGNING = {
  type: "warning",
  message: "Bundles are unsigned.",
  next: "To sign them, run:",
  command: "npx hot-updater secrets issue bundle-signing-key",
};

const mockGetCwd = getCwd as ReturnType<typeof vi.fn>;
const mockCheckFingerprintJson = vi.mocked(checkFingerprintJson);
const mockLoadConfig = loadConfig as ReturnType<typeof vi.fn>;
const mockReadPackageUp = readPackageUp as ReturnType<typeof vi.fn>;

const createConfig = (overrides: Record<string, unknown> = {}) => ({
  build: async () => ({
    build: vi.fn(),
    name: "test-build",
  }),
  storage: createReleaseCatalogTestStorage(),
  updateStrategy: "appVersion",
  platform: {
    ios: {
      infoPlistPaths: [],
    },
    android: {
      androidManifestPaths: [],
    },
  },
  ...overrides,
});

const createTempProject = async () =>
  await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-doctor-"));

const writeFile = async (filePath: string, content: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
};

const writeInfoPlist = async (
  cwd: string,
  body: string,
  filePath = "ios/App/Info.plist",
) => {
  await writeFile(
    path.join(cwd, filePath),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`,
  );
};

const writeAndroidManifest = async (
  cwd: string,
  metaData: string,
  filePath = "android/app/src/main/AndroidManifest.xml",
) => {
  await writeFile(
    path.join(cwd, filePath),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest>
  <application>
${metaData}
  </application>
</manifest>
`,
  );
};

describe("areVersionsCompatible", () => {
  // Test cases for exact matches
  it("should return true for exact version matches", () => {
    expect(areVersionsCompatible("1.0.0", "1.0.0")).toBe(true);
  });

  it("should return true for exact range matches", () => {
    expect(areVersionsCompatible("^1.0.0", "^1.0.0")).toBe(true);
  });

  // Test cases for version satisfying range
  it("should return true when versionA satisfies versionB range", () => {
    expect(areVersionsCompatible("1.0.1", "^1.0.0")).toBe(true);
    expect(areVersionsCompatible("0.18.2", "^0.18.0")).toBe(true);
    expect(areVersionsCompatible("1.2.5", "~1.2.0")).toBe(true);
    expect(areVersionsCompatible("1.2.3", "1.2.x")).toBe(true);
    expect(areVersionsCompatible("1.0.0-alpha.1", "^1.0.0-alpha")).toBe(true);
    expect(areVersionsCompatible("0.18.0", "^0.18.0")).toBe(true);
  });

  it("should return true when versionB satisfies versionA range", () => {
    expect(areVersionsCompatible("^1.0.0", "1.0.1")).toBe(true);
    expect(areVersionsCompatible("^0.18.0", "0.18.2")).toBe(true);
    expect(areVersionsCompatible("~1.2.0", "1.2.5")).toBe(true);
    expect(areVersionsCompatible("1.2.x", "1.2.3")).toBe(true);
    expect(areVersionsCompatible("^1.0.0-alpha", "1.0.0-alpha.1")).toBe(true);
    expect(areVersionsCompatible("^0.18.0", "0.18.0")).toBe(true);
  });

  // Test cases for non-compatible versions/ranges
  it("should follow semver compatibility for stable package versions", () => {
    expect(areVersionsCompatible("1.0.0", "1.0.1")).toBe(true);
    expect(areVersionsCompatible("1.0.0", "1.1.0")).toBe(true);
    expect(areVersionsCompatible("^1.0.0", "^1.1.0")).toBe(true);
    expect(areVersionsCompatible("0.31.4", "0.31.9")).toBe(true);
    expect(areVersionsCompatible("^0.31.4", "0.31.9")).toBe(true);
    expect(areVersionsCompatible("0.31.4", "0.32.0")).toBe(false);
  });

  it("should return false when versionA does not satisfy versionB range", () => {
    expect(areVersionsCompatible("2.0.0", "^1.0.0")).toBe(false);
    expect(areVersionsCompatible("0.17.0", "^0.18.0")).toBe(false);
    expect(areVersionsCompatible("1.0.0-alpha", "^1.0.0-beta")).toBe(false);
  });

  it("should return false when versionB does not satisfy versionA range", () => {
    expect(areVersionsCompatible("^2.0.0", "1.0.0")).toBe(false);
    expect(areVersionsCompatible("^0.17.0", "0.18.0")).toBe(false);
  });

  // Test cases with invalid version/range strings
  it("should return false for invalid version or range strings", () => {
    expect(areVersionsCompatible("invalid-version", "1.0.0")).toBe(false);
    expect(areVersionsCompatible("1.0.0", "invalid-range")).toBe(false);
    expect(areVersionsCompatible("latest", "1.0.0")).toBe(false);
    expect(areVersionsCompatible("1.0.0", "latest")).toBe(false);
    expect(areVersionsCompatible("invalid", "invalid")).toBe(true);
  });

  it("should handle complex range comparisons correctly", () => {
    expect(areVersionsCompatible("1.2.3", ">=1.0.0 <2.0.0")).toBe(true);
    expect(areVersionsCompatible(">=1.0.0 <2.0.0", "1.2.3")).toBe(true);
    expect(areVersionsCompatible("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(areVersionsCompatible(">=1.0.0 <2.0.0", "2.0.0")).toBe(false);
  });

  it("should handle pre-releases correctly with ranges", () => {
    expect(areVersionsCompatible("1.0.0-beta.1", "^1.0.0-alpha.1")).toBe(true);
    expect(areVersionsCompatible("^1.0.0-alpha.1", "1.0.0-beta.1")).toBe(true);
    expect(areVersionsCompatible("1.0.0", "^1.0.0-alpha.1")).toBe(true);
    expect(areVersionsCompatible("^1.0.0-alpha.1", "1.0.0")).toBe(true);
    expect(areVersionsCompatible("2.0.0-alpha.1", "^1.0.0")).toBe(false);
  });

  it("should accept increments within the same pre-release channel", () => {
    expect(areVersionsCompatible("1.1.0-beta.1", "1.1.0-beta.0")).toBe(true);
    expect(areVersionsCompatible("1.1.0-beta.0", "1.1.0-beta.1")).toBe(true);
    expect(areVersionsCompatible("1.1.1-beta.0", "1.1.0-beta.0")).toBe(false);
  });
});

describe("infrastructure version helpers", () => {
  it("resolves the newest infrastructure target a release reaches", () => {
    expect(getRequiredInfrastructureVersion("0.36.0")).toBe("1.0.0");
    expect(getRequiredInfrastructureVersion("1.0.0")).toBe("1.0.0");
    expect(getRequiredInfrastructureVersion("1.1.5")).toBe("1.0.0");
    expect(getRequiredInfrastructureVersion("1.2.0")).toBe("1.2.0");
  });

  it("resolves generation 1 as the only server runtime target", () => {
    expect(getRequiredServerVersion("0.36.0")).toBe("1.0.0");
    expect(getRequiredServerVersion("1.0.0")).toBe("1.0.0");
  });

  it("does not require an update just because the server package version is newer", () => {
    expect(
      isInfrastructureUpdateRequired({
        serverVersion: "0.30.1",
        requiredVersion: "0.30.0",
      }),
    ).toBe(false);
  });

  it("requires an update when the server is below the required infrastructure target", () => {
    expect(
      isInfrastructureUpdateRequired({
        serverVersion: "0.29.8",
        requiredVersion: "0.30.0",
      }),
    ).toBe(true);
    expect(
      isInfrastructureUpdateRequired({
        serverVersion: "0.30.2",
        requiredVersion: "0.31.0",
      }),
    ).toBe(true);
    expect(
      isInfrastructureUpdateRequired({
        serverVersion: "0.31.9",
        requiredVersion: "0.32.0",
      }),
    ).toBe(true);
  });

  it.each([
    ["1.0.0-beta.2", false],
    ["1.0.0-beta.1", true],
    ["1.0.0", false],
  ])(
    "checks server %s against the runtime a prerelease CLI ships",
    async (serverVersion, needsUpdate) => {
      const requiredTarget = getRequiredUpdateTarget(
        "1.0.0-beta.4",
        "1.0.0-beta.2",
      );
      expect(requiredTarget.version).toBe("1.0.0");
      const status = await checkInfrastructureStatus({
        serverBaseUrl: "https://updates.example.com",
        requiredTarget,
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            infrastructureGeneration: 1,
            version: serverVersion,
          }),
        ),
      });
      expect(status).toMatchObject({
        requiredVersion: "1.0.0-beta.2",
        needsUpdate,
      });
      expect(status.upgradeBlocked).toBeUndefined();
    },
  );

  it("does not relax a stable CLI's requirement for a prerelease server", async () => {
    const requiredTarget = getRequiredUpdateTarget("1.0.0", "1.0.0-beta.2");
    const status = await checkInfrastructureStatus({
      serverBaseUrl: "https://updates.example.com",
      requiredTarget,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          infrastructureGeneration: 1,
          version: "1.0.0-beta.2",
        }),
      ),
    });
    expect(status).toMatchObject({
      requiredVersion: "1.0.0",
      needsUpdate: true,
    });
  });

  it("does not relax the baseline for a different server core version", () => {
    expect(
      getRequiredUpdateTarget("1.0.0-beta.4", "0.99.0-beta.2"),
    ).not.toHaveProperty("minimumPrereleaseVersion");
  });

  it("still blocks a missing generation marker on the runtime a prerelease CLI ships", async () => {
    const status = await checkInfrastructureStatus({
      serverBaseUrl: "https://updates.example.com",
      requiredTarget: getRequiredUpdateTarget("1.0.0-beta.4", "1.0.0-beta.2"),
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ version: "1.0.0-beta.2" })),
    });
    expect(status.upgradeBlocked).toBe(true);
    expect(status.needsUpdate).toBeUndefined();
  });

  it("resolves the version endpoint from the server base URL", () => {
    expect(resolveVersionEndpoint("https://example.com/api/check-update")).toBe(
      "https://example.com/api/check-update/version",
    );
    expect(
      resolveVersionEndpoint("https://example.com/api/check-update/"),
    ).toBe("https://example.com/api/check-update/version");
  });

  it("directs an outdated generation 1 server to versioned agent upgrade instructions", async () => {
    const status = await checkInfrastructureStatus({
      serverBaseUrl: "https://updates.example.com",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ infrastructureGeneration: 1, version: "1.0.0" }),
        ),
      requiredTarget: { version: "1.1.0", note: "Test upgrade requirement" },
    });

    expect(status.needsUpdate).toBe(true);
    expect(createInfrastructureRemediation(status)).toMatchObject({
      commands: expect.arrayContaining(["npx hot-updater agent infra upgrade"]),
    });
  });

  it("blocks a v0 endpoint instead of suggesting an in-place update", async () => {
    const status = await checkInfrastructureStatus({
      serverBaseUrl: "https://updates.example.com",
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ version: "0.38.0" })),
      requiredTarget: {
        version: "1.0.0",
        note: "Release Catalog infrastructure generation",
      },
    });

    expect(status).toMatchObject({
      serverVersion: "0.38.0",
      upgradeBlocked: true,
      updateReason: "Existing infrastructure does not declare generation 1",
    });
    expect(status.needsUpdate).toBeUndefined();
    expect(createInfrastructureRemediation(status)).toEqual({
      reason: expect.stringContaining("cannot be upgraded in place"),
      commands: ["hot-updater agent infra setup", "hot-updater init"],
    });
  });

  it("accepts a v1 infrastructure generation marker", async () => {
    const status = await checkInfrastructureStatus({
      serverBaseUrl: "https://updates.example.com",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          infrastructureGeneration: 1,
          version: "1.0.0",
        }),
      ),
      requiredTarget: {
        version: "1.0.0",
        note: "Release Catalog infrastructure generation",
      },
    });

    expect(status).toMatchObject({
      infrastructureGeneration: 1,
      needsUpdate: false,
    });
    expect(status.upgradeBlocked).toBeUndefined();
  });
});

describe("doctor", () => {
  const tempProjects: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    // No Play key from this machine, and no request to Google: a spec that
    // checks Play access stores its key and answers for it.
    for (const name of [
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    ]) {
      vi.stubEnv(name, "");
    }
    checkPlayAccess.mockReset();
    checkPlayAccess.mockRejectedValue(new Error("No Play request in specs."));
    packageJsonData.version = "1.0.0";
    mockGetCwd.mockReturnValue("/mock/cwd");
    mockLoadConfig.mockResolvedValue(createConfig());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempProjects.map((project) =>
        fs.rm(project, { recursive: true, force: true }),
      ),
    );
    tempProjects.length = 0;
  });

  it("should return true for a healthy setup", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^0.18.2",
          "@hot-updater/protocol": "^0.18.2",
          "@hot-updater/react-native": "^0.18.2",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toMatchObject(HEALTHY_WITHOUT_SERVER);
    expect(result).not.toHaveProperty("details.versionMismatches");
  });

  it("prints machine-readable JSON without prompting", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^0.18.2",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleDoctor({ json: true });

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject(
      HEALTHY_WITHOUT_SERVER,
    );
    expect(p.text).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("lists where each build credential's secret() is read from, and --json gives the same fields", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: { dependencies: { "hot-updater": "^0.18.2" } },
      path: "/mock/cwd/package.json",
    });
    vi.stubEnv("HOT_UPDATER_ANDROID_KEYSTORE_PATH", "/tmp/release.jks");
    const get = vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(
        names.map((name) => [name, name === "asc-api-key" ? "{}" : undefined]),
      ),
    );
    mockLoadConfig.mockResolvedValue(
      createConfig({
        secrets: { name: "team-store", get },
        nativeBuild: {
          ios: { release: { signing: { ascApiKey: secret("asc-api-key") } } },
          android: {
            release: { signing: { keystore: secret("release-keystore") } },
          },
        },
        signing: { enabled: true, privateKey: secret("bundle-signing-key") },
      }),
    );

    await handleDoctor({ serverBaseUrl: undefined }).catch(() => {});

    const block = vi
      .mocked(p.log.step)
      .mock.calls.map(([message]) => stripVTControlCharacters(String(message)))
      .find((message) => message.startsWith("Secrets"));
    expect(block).toBe(
      [
        "Secrets",
        "Adapter             team-store",
        "asc-api-key         in the adapter",
        "release-keystore    set by the environment, none in the adapter",
        "bundle-signing-key  missing",
      ].join("\n"),
    );
    // One get for every build credential; Google Play's row reads its key.
    expect(get.mock.calls.map(([names]) => names)).toEqual([
      ["asc-api-key", "release-keystore", "bundle-signing-key"],
      ["play-service-account"],
    ]);
    // Deploy reads the signing key: its absence fails doctor, with how to
    // import the key, never a new one.
    const error = vi
      .mocked(p.log.error)
      .mock.calls.map(([message]) => stripVTControlCharacters(String(message)));
    expect(error).toContain(
      [
        "bundle-signing-key isn't in the team-store secrets adapter.",
        "Check the name and your access, or import your key:",
        "npx hot-updater secrets put bundle-signing-key <key.pem>",
      ].join("\n"),
    );
    expect(p.log.success).not.toHaveBeenCalledWith("All checks passed.");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    await expect(handleDoctor({ json: true })).rejects.toThrow(
      "process.exit:1",
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      success: false,
      details: {
        secrets: {
          adapter: "team-store",
          references: [
            {
              name: "asc-api-key",
              fields: ["nativeBuild.ios.release.signing.ascApiKey"],
              required: true,
              source: "adapter",
              inAdapter: true,
            },
            {
              name: "release-keystore",
              required: true,
              source: "environment",
              inAdapter: false,
            },
            {
              name: "bundle-signing-key",
              required: true,
              source: "missing",
              message: expect.stringContaining(
                "secrets put bundle-signing-key <key.pem>",
              ),
            },
          ],
        },
      },
    });
    exitSpy.mockRestore();
    logSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("fails on a release keystore the secrets adapter lacks, and Google Play isn't ✓ without it", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: { dependencies: { "hot-updater": "^0.18.2" } },
      path: "/mock/cwd/package.json",
    });
    for (const name of [
      "HOT_UPDATER_ANDROID_KEYSTORE_PATH",
      "HOT_UPDATER_ANDROID_KEYSTORE_BASE64",
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_PATH",
      "HOT_UPDATER_PLAY_SERVICE_ACCOUNT_JSON",
    ]) {
      vi.stubEnv(name, "");
    }
    // The Play key is stored and reaches the app; the keystore is not.
    checkPlayAccess.mockResolvedValue({
      status: "ready",
      email: "play@my-app.iam.gserviceaccount.com",
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        secrets: holding({
          "play-service-account": JSON.stringify({
            type: "service_account",
            client_email: "play@my-app.iam.gserviceaccount.com",
            private_key:
              "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
          }),
        }),
        nativeBuild: {
          android: {
            release: {
              packageName: "com.example.app",
              signing: { keystore: secret("release-keystore") },
            },
          },
        },
        signing: { enabled: false },
      }),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);

    await expect(handleDoctor({ serverBaseUrl: undefined })).rejects.toThrow(
      "process.exit:1",
    );

    const printed = (level: "step" | "warn" | "error" | "success") =>
      vi
        .mocked(p.log[level])
        .mock.calls.map(([message]) =>
          stripVTControlCharacters(String(message)),
        );
    expect(printed("step")).toContain(
      [
        "Secrets",
        "Adapter           team-store",
        "release-keystore  missing",
      ].join("\n"),
    );
    expect(printed("error")).toContain(
      [
        "release-keystore isn't in the team-store secrets adapter.",
        "Check the name and your access, or import your key:",
        "npx hot-updater secrets put release-keystore --kind android-keystore \\",
        "  <upload.jks>",
      ].join("\n"),
    );
    const play = [...printed("step"), ...printed("warn")].find((message) =>
      message.startsWith("Google Play"),
    );
    expect(play).toBe(
      [
        "Google Play",
        "✗ com.example.app      upload keystore missing",
        "Guide: https://hot-updater.dev/docs/native-builds/google-play",
      ].join("\n"),
    );
    expect(printed("warn")).toContain(play);
    expect(printed("success")).not.toContain("All checks passed.");

    // --json says the same, and exits non-zero too.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(handleDoctor({ json: true })).rejects.toThrow(
      "process.exit:1",
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      success: false,
      details: {
        secrets: {
          references: [
            {
              name: "release-keystore",
              required: true,
              source: "missing",
            },
          ],
        },
        googlePlay: {
          packages: [
            {
              packageName: "com.example.app",
              access: { status: "ready" },
              missingKeystore: "release-keystore",
            },
          ],
        },
      },
    });
    logSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("warns, and puts the cause under its own head line, when the adapter can't be read", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: { dependencies: { "hot-updater": "^0.18.2" } },
      path: "/mock/cwd/package.json",
    });
    const cause = [
      "infisical() found no Infisical sign-in. Set one of:",
      "- INFISICAL_TOKEN",
      "- INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
      "  with INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
      "- INFISICAL_MACHINE_IDENTITY_ID, in GitHub Actions",
      "https://hot-updater.dev/docs/guides/secrets-adapters/infisical#sign-in-on-your-machine",
    ].join("\n");
    mockLoadConfig.mockResolvedValue(
      createConfig({
        secrets: {
          name: "infisical",
          get: async () => {
            throw new Error(cause);
          },
          set: async () => {},
        },
        signing: secret("bundle-signing-key"),
      }),
    );

    await handleDoctor({ serverBaseUrl: undefined });

    expect(
      vi
        .mocked(p.log.warn)
        .mock.calls.map(([message]) =>
          stripVTControlCharacters(String(message)),
        ),
    ).toContain(`Couldn't read the infisical secrets adapter.\n${cause}`);
    // It can't tell what is missing: the run passes, and counts the
    // warnings, the unchecked server's too.
    expect(p.log.success).toHaveBeenCalledWith(
      "All checks passed with 2 warnings.",
    );
  });

  it("warns on a missing secret only a debug variant or a simulator scheme names, and passes", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: { dependencies: { "hot-updater": "^0.18.2" } },
      path: "/mock/cwd/package.json",
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        secrets: holding({}),
        nativeBuild: {
          ios: {
            simulator: {
              simulator: true,
              signing: { ascApiKey: secret("qa-missing-sim-asc") },
            },
          },
          android: {
            debug: {
              packageName: "com.example.app",
              variant: "debug",
              signing: { keystore: secret("qa-missing-debug-keystore") },
            },
          },
        },
        signing: { enabled: false },
      }),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);

    await handleDoctor({ serverBaseUrl: undefined });

    const lines = renderClackLog(recordedClackCalls(p.log, p));
    // The Secrets block is the warning, as the Google Play row's is.
    expect(lines.join("\n")).toContain(
      [
        "▲  Secrets",
        "│  Adapter                    team-store",
        "│  qa-missing-sim-asc         missing, unused",
        "│  qa-missing-debug-keystore  missing, unused",
      ].join("\n"),
    );
    // The unchecked server's warning, and this one.
    expect(lines.slice(-3)).toEqual([
      "◆  All checks passed with 2 warnings.",
      "│",
      "└  Doctor complete.",
    ]);
    expect(exitSpy).not.toHaveBeenCalled();

    // --json lists it as a warning, and passes too.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleDoctor({ json: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      success: true,
      details: {
        secrets: {
          references: [
            { name: "qa-missing-sim-asc", required: false, source: "missing" },
            {
              name: "qa-missing-debug-keystore",
              required: false,
              source: "missing",
            },
          ],
          issues: [
            {
              type: "warning",
              code: "SECRETS_MISSING_UNUSED",
              names: ["qa-missing-sim-asc", "qa-missing-debug-keystore"],
              message:
                "qa-missing-sim-asc and qa-missing-debug-keystore are missing, and no build reads them.",
            },
          ],
        },
      },
    });
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("closes a failing --scope run with its errors too", async () => {
    const infraDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-doctor-scope-"),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);

    // An empty directory is no scaffold: its checks fail.
    await expect(handleDoctor({ scope: "scaffold", infraDir })).rejects.toThrow(
      "process.exit:1",
    );

    const lines = renderClackLog(recordedClackCalls(p.log, p));
    const errors = lines.filter((line) => line.startsWith("■")).length;
    expect(errors).toBeGreaterThan(0);
    expect(lines.at(-1)).toBe(
      `└  Doctor found ${errors} error${errors === 1 ? "" : "s"}.`,
    );
    exitSpy.mockRestore();
    await fs.rm(infraDir, { recursive: true, force: true });
  });

  it("closes a failing run with its errors and warnings, as a passing one closes", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: { dependencies: { "hot-updater": "^0.18.2" } },
      path: "/mock/cwd/package.json",
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        secrets: holding({}),
        nativeBuild: {
          android: {
            release: {
              packageName: "com.example.app",
              signing: { keystore: secret("qa-missing-keystore") },
            },
          },
        },
        signing: { enabled: false },
      }),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);

    await expect(handleDoctor({ serverBaseUrl: undefined })).rejects.toThrow(
      "process.exit:1",
    );

    const lines = renderClackLog(recordedClackCalls(p.log, p));
    const marks = (mark: string) =>
      lines.filter((line) => line.startsWith(mark)).length;
    // One line, the last, counts each ■ and ▲ the run printed: the missing
    // keystore, and the unchecked server.
    expect([marks("■"), marks("▲")]).toEqual([1, 1]);
    expect(lines.slice(-2)).toEqual([
      "│",
      "└  Doctor found 1 error, 1 warning.",
    ]);
    expect(marks("└")).toBe(1);
    expect(lines.join("\n")).not.toContain("All checks passed");
    exitSpy.mockRestore();
  });

  it.skipIf(!realKeytool)(
    "marks a stored upload keystore its passwords don't open, with how to store it again",
    async () => {
      mockReadPackageUp.mockResolvedValue({
        packageJson: { dependencies: { "hot-updater": "^0.18.2" } },
        path: "/mock/cwd/package.json",
      });
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "hot-updater-doctor-keystore-"),
      );
      const file = path.join(directory, "upload.p12");
      const created = await execa(
        process.env["JAVA_HOME"]
          ? path.join(process.env["JAVA_HOME"], "bin", "keytool")
          : "keytool",
        [
          "-genkeypair",
          "-noprompt",
          "-keystore",
          file,
          "-storetype",
          "PKCS12",
          "-alias",
          "upload",
          "-keyalg",
          "RSA",
          "-keysize",
          "2048",
          "-validity",
          "30",
          "-dname",
          "CN=spec",
          "-storepass",
          "store-secret-1",
          "-keypass",
          "store-secret-1",
        ],
        { reject: false },
      );
      expect(created.exitCode).toBe(0);
      const value = androidKeystoreValue({
        keystore: await fs.readFile(file),
        storePassword: "store-secret-1",
        keyAlias: "upload",
        keyPassword: "eas-key-secret",
      });
      await fs.rm(directory, { recursive: true, force: true });
      mockLoadConfig.mockResolvedValue(
        createConfig({
          secrets: {
            name: "team-store",
            get: vi.fn(async (names: readonly string[]) =>
              Object.fromEntries(names.map((name) => [name, value])),
            ),
          },
          nativeBuild: {
            android: {
              release: { signing: { keystore: secret("release-keystore") } },
            },
          },
          signing: { enabled: false },
        }),
      );

      await handleDoctor({ serverBaseUrl: undefined }).catch(() => {});

      const printed = (level: "step" | "warn") =>
        vi
          .mocked(p.log[level])
          .mock.calls.map(([message]) =>
            stripVTControlCharacters(String(message)),
          );
      expect(
        printed("step").find((message) => message.startsWith("Secrets")),
      ).toBe(
        [
          "Secrets",
          "Adapter           team-store",
          "release-keystore  in the adapter, doesn't open",
        ].join("\n"),
      );
      const warning = printed("warn").find((message) =>
        message.startsWith("release-keystore:"),
      );
      expect(warning).toBe(
        [
          'release-keystore: The key password doesn\'t unlock "upload".',
          "For PKCS12 keystores, the key password is the store password.",
          "Store it again:",
          "npx hot-updater secrets put release-keystore --kind android-keystore \\",
          "  <upload.jks>",
        ].join("\n"),
      );
      expect(linesWiderThan(warning!.split("\n"), 76)).toEqual([]);
    },
    60_000,
  );

  it("exits non-zero when the default output reports a doctor error", async () => {
    mockReadPackageUp.mockResolvedValue(null);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await handleDoctor({ serverBaseUrl: "https://example.com/api" }).catch(
      () => {},
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits non-zero when the JSON output reports a doctor error", async () => {
    mockReadPackageUp.mockResolvedValue(null);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await handleDoctor({ json: true }).catch(() => {});

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("should return true for a healthy setup", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.18.2",
          "@hot-updater/protocol": "^0.18.2",
          "@hot-updater/react-native": "^0.18.2",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toMatchObject(HEALTHY_WITHOUT_SERVER);
    expect(result).not.toHaveProperty("details.versionMismatches");
  });

  it("should return true for a healthy setup", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^0.18.2",
          "@hot-updater/protocol": "0.18.2",
          "@hot-updater/react-native": "0.18.2",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toMatchObject(HEALTHY_WITHOUT_SERVER);
    expect(result).not.toHaveProperty("details.versionMismatches");
  });

  it("should return true for a healthy setup", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^0.18.2",
          "@hot-updater/protocol": "0.17.0",
          "@hot-updater/react-native": "0.17.0",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toEqual({
      details: {
        signing: UNSIGNED_SIGNING,
        hotUpdaterVersion: "^0.18.2",
        infrastructureUnchecked: expect.objectContaining({
          commands: ["npx hot-updater doctor --server-base-url <url>"],
        }),
        installedHotUpdaterPackages: [
          "@hot-updater/protocol",
          "@hot-updater/react-native",
        ],
        packageJsonPath: "/mock/cwd/package.json",
        versionMismatches: [
          {
            currentVersion: "0.17.0",
            expectedVersion: "^0.18.2",
            packageName: "@hot-updater/protocol",
          },
          {
            currentVersion: "0.17.0",
            expectedVersion: "^0.18.2",
            packageName: "@hot-updater/react-native",
          },
        ],
      },
      success: false,
    });
  });

  it("should return true for a healthy setup", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^1.0.0",
          "@hot-updater/protocol": "1.1.0",
          "@hot-updater/plugin-react-native": "^1.2.0",
        },
        devDependencies: {
          "some-other-package": "2.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toMatchObject(HEALTHY_WITHOUT_SERVER);
    expect(result).not.toHaveProperty("details.versionMismatches");
  });

  it("should return an error if package.json is not found", async () => {
    mockReadPackageUp.mockResolvedValue(undefined);

    const result = await doctor();
    expect(result).toEqual({
      success: false,
      error: "Could not find package.json",
    });
  });

  it("should return an error if hot-updater CLI is not found", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "@hot-updater/protocol": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toEqual({
      success: false,
      error: "hot-updater CLI not found. Please install it first.",
    });
  });

  it("should detect version mismatches", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^1.0.0",
          "@hot-updater/protocol": "2.0.0",
          "@hot-updater/plugin-A": "1.0.1",
        },
        devDependencies: {
          "@hot-updater/plugin-B": "0.9.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toEqual({
      success: false,
      details: {
        signing: UNSIGNED_SIGNING,
        hotUpdaterVersion: "^1.0.0",
        infrastructureUnchecked: expect.objectContaining({
          commands: ["npx hot-updater doctor --server-base-url <url>"],
        }),
        packageJsonPath: "/mock/cwd/package.json",
        installedHotUpdaterPackages: [
          "@hot-updater/protocol",
          "@hot-updater/plugin-A",
          "@hot-updater/plugin-B",
        ],
        versionMismatches: [
          {
            packageName: "@hot-updater/protocol",
            currentVersion: "2.0.0",
            expectedVersion: "^1.0.0",
          },
          {
            packageName: "@hot-updater/plugin-B",
            currentVersion: "0.9.0",
            expectedVersion: "^1.0.0",
          },
        ],
      },
    });
  });

  it("should return true if only hot-updater CLI is present and no other @hot-updater packages", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "^1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toMatchObject(HEALTHY_WITHOUT_SERVER);
    expect(result).not.toHaveProperty("details.versionMismatches");
  });

  it("should not report package mismatches for patch differences", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.0.0",
          "@hot-updater/protocol": "1.0.1",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toMatchObject(HEALTHY_WITHOUT_SERVER);
    expect(result).not.toHaveProperty("details.versionMismatches");
  });

  it("should accept independently released packages in the same prerelease", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.1.0-beta.0",
          "@hot-updater/cloudflare": "1.1.0-beta.0",
          "@hot-updater/expo": "1.1.0-beta.1",
          "@hot-updater/react-native": "1.1.0-beta.1",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toMatchObject(HEALTHY_WITHOUT_SERVER);
    expect(result).not.toHaveProperty("details.versionMismatches");
  });

  it("should handle empty dependencies and devDependencies", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const result = await doctor();
    expect(result).toMatchObject(HEALTHY_WITHOUT_SERVER);
    expect(result).not.toHaveProperty("details.versionMismatches");

    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        devDependencies: {
          "hot-updater": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const result2 = await doctor();
    expect(result2).toMatchObject(HEALTHY_WITHOUT_SERVER);

    mockReadPackageUp.mockResolvedValue({
      packageJson: {},
      path: "/mock/cwd/package.json",
    });
    const result3 = await doctor();
    expect(result3).toEqual({
      success: false,
      error: "hot-updater CLI not found. Please install it first.",
    });
  });

  it.each(["1.0.0-beta.4", "^1.0.0-beta.4", "~1.0.0-beta.4"])(
    "uses the executing CLI runtime rather than the %s dependency declaration",
    async (declaredVersion) => {
      packageJsonData.version = "1.0.0-beta.4";
      mockReadPackageUp.mockResolvedValue({
        packageJson: { devDependencies: { "hot-updater": declaredVersion } },
        path: "/mock/cwd/package.json",
      });
      const result = await doctor({
        serverBaseUrl: "https://updates.example.com",
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            infrastructureGeneration: 1,
            version: HOT_UPDATER_SERVER_VERSION,
          }),
        ),
      });
      expect(result).toMatchObject({
        success: true,
        details: { infrastructure: { needsUpdate: false } },
      });
    },
  );

  it("should pass when the endpoint declares infrastructure generation 1", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          infrastructureGeneration: 1,
          version: "1.0.0",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const result = await doctor({
      serverBaseUrl: "https://example.com",
      fetch: fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/version", {
      headers: {
        Accept: "application/json",
      },
    });
    expect(result).toEqual({
      success: true,
      details: {
        signing: UNSIGNED_SIGNING,
        hotUpdaterVersion: "1.0.0",
        installedHotUpdaterPackages: [],
        packageJsonPath: "/mock/cwd/package.json",
        infrastructure: {
          baseUrl: "https://example.com",
          versionEndpoint: "https://example.com/version",
          serverVersion: "1.0.0",
          infrastructureGeneration: 1,
          requiredVersion: "1.0.0",
          needsUpdate: false,
        },
      },
    });
  });

  it("accepts a direct Supabase Edge URL as origin-only mode", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: { dependencies: { "hot-updater": "1.0.0" } },
      path: "/mock/cwd/package.json",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ infrastructureGeneration: 1, version: "1.0.0" }),
    );

    const result = await doctor({
      fetch: fetchImpl,
      serverBaseUrl: "https://project.supabase.co/functions/v1/update-server",
    });

    expect(result).toMatchObject({
      success: true,
      details: {
        infrastructure: {
          catalogMode: "origin-only",
          catalogModeNote: expect.stringContaining(
            "still invokes the Supabase Edge Function",
          ),
          needsUpdate: false,
        },
      },
    });
    expect(result).not.toMatchObject({
      details: { infrastructure: { remediation: expect.anything() } },
    });
  });

  it("blocks a v0 endpoint instead of suggesting an in-place update", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ version: "0.36.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await doctor({
      serverBaseUrl: "https://example.com",
      fetch: fetchImpl,
    });

    expect(result).toMatchObject({
      success: false,
      details: {
        infrastructure: {
          serverVersion: "0.36.0",
          requiredVersion: "1.0.0",
          upgradeBlocked: true,
          updateReason: "Existing infrastructure does not declare generation 1",
          remediation: {
            commands: ["hot-updater agent infra setup", "hot-updater init"],
          },
        },
      },
    });
  });

  it("blocks a missing version endpoint as an in-place upgrade", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response("Not found", { status: 404 });
    });

    const result = await doctor({
      serverBaseUrl: "https://example.com",
      fetch: fetchImpl,
    });

    expect(result).toMatchObject({
      success: false,
      details: {
        infrastructure: {
          versionEndpoint: "https://example.com/version",
          requiredVersion: "1.0.0",
          upgradeBlocked: true,
          updateReason:
            "v1 infrastructure marker not found at the existing endpoint",
          remediation: {
            commands: ["hot-updater agent infra setup", "hot-updater init"],
          },
        },
      },
    });
  });

  it.each<[string, () => ConfiguredDatabase]>([
    [
      "the server's database",
      () => ({ name: "memory", adapter: createMemoryAdapter() }),
    ],
    [
      "standaloneRepository",
      () => ({
        name: "standalone",
        // A self-hosted server's admin API, which doctor reads no plugins from.
        core: assembleServer({
          database: { name: "memory", adapter: createMemoryAdapter() },
        }).core,
        fetchAdmin: vi.fn(async () => {
          throw new Error("doctor fetched the admin API");
        }),
      }),
    ],
  ])(
    "warns about a client plugin the config's plugins need that the app does not add, over %s",
    async (_database, database) => {
      const cwd = await createTempProject();
      tempProjects.push(cwd);
      mockGetCwd.mockReturnValue(cwd);
      mockReadPackageUp.mockResolvedValue({
        packageJson: {
          dependencies: {
            "hot-updater": "0.31.0",
            "@hot-updater/react-native": "0.31.0",
          },
        },
        path: path.join(cwd, "package.json"),
      });
      const configured = database();
      mockLoadConfig.mockResolvedValue(
        createConfig({ database: configured, plugins: [insights()] }),
      );
      await writeFile(
        path.join(cwd, "src/App.tsx"),
        'import { HotUpdater } from "@hot-updater/react-native";\n',
      );

      const result = await doctor();

      expect(result).toMatchObject({
        success: true,
        details: {
          native: {
            issues: [
              {
                type: "warning",
                platform: "project",
                code: "MISSING_CLIENT_PLUGIN",
                message:
                  "The server runs a plugin whose client plugin insights the app does not add.",
                resolution:
                  'Import { insights } from "@hot-updater/react-native" and pass insights() to HotUpdater.init({ plugins }).',
              },
            ],
          },
        },
      });
      if ("fetchAdmin" in configured) {
        expect(configured.fetchAdmin).not.toHaveBeenCalled();
      }
    },
  );

  it("warns that it could not check client plugins when the config's plugins do not assemble", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        database: { name: "memory", adapter: createMemoryAdapter() },
        plugins: [insights(), insights()],
      }),
    );

    const result = await doctor();

    expect(result).toMatchObject({
      success: true,
      details: {
        native: {
          issues: [
            {
              type: "warning",
              platform: "project",
              code: "CLIENT_PLUGINS_UNCHECKED",
              message: expect.stringContaining(
                "Could not read the plugins in hot-updater.config.ts to check the app's client plugins:",
              ),
              resolution:
                "Check that plugins in hot-updater.config.ts load, then rerun doctor.",
            },
          ],
        },
      },
    });
  });

  it("detects missing native integration in existing React Native projects", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        platform: {
          ios: {
            infoPlistPaths: ["ios/App/Info.plist"],
          },
          android: {
            androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
          },
        },
      }),
    );

    await writeInfoPlist(cwd, "");
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      'import UIKit\nfunc bundleURL() { Bundle.main.url(forResource: "main", withExtension: "jsbundle") }\n',
    );
    await writeAndroidManifest(cwd, "");
    await writeFile(
      path.join(
        cwd,
        "android/app/src/main/java/com/example/MainApplication.kt",
      ),
      "class MainApplication",
    );

    const result = await doctor();

    expect(result).toMatchObject({
      success: false,
      details: {
        native: {
          updateStrategy: "appVersion",
          ios: {
            detected: true,
            bundleProviderConfigured: false,
          },
          android: {
            detected: true,
            bundleProviderConfigured: false,
          },
        },
      },
    });
    expect(result).not.toBe(true);
    if (result !== true) {
      expect(result.details?.native?.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "MISSING_IOS_BUNDLE_PROVIDER",
          "MISSING_ANDROID_BUNDLE_PROVIDER",
        ]),
      );
    }
  });

  it("passes native integration checks when iOS and Android are configured", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        platform: {
          ios: {
            infoPlistPaths: ["ios/App/Info.plist"],
          },
          android: {
            androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
          },
        },
      }),
    );

    await writeInfoPlist(
      cwd,
      "<key>HOT_UPDATER_CHANNEL</key>\n<string>production</string>",
    );
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
    );
    await writeAndroidManifest(
      cwd,
      '    <meta-data android:name="com.hotupdater.CHANNEL" android:value="production" />',
    );
    await writeFile(
      path.join(
        cwd,
        "android/app/src/main/java/com/example/MainApplication.kt",
      ),
      "import com.hotupdater.HotUpdater\nval bundle = HotUpdater.getJSBundleFile(applicationContext)\n",
    );

    const result = await doctor();

    expect(result).toMatchObject({
      success: true,
      details: {
        native: {
          ios: {
            channel: "production",
            bundleProviderConfigured: true,
          },
          android: {
            channel: "production",
            bundleProviderConfigured: true,
          },
          issues: [],
        },
      },
    });
  });

  it("finds HotUpdater.bundleURL() in SceneDelegate for apps that host React there", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        platform: {
          ios: { infoPlistPaths: ["ios/App/Info.plist"] },
          android: { androidManifestPaths: [] },
        },
      }),
    );

    await writeInfoPlist(cwd, "");
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      "import UIKit\nclass AppDelegate: UIResponder {}\n",
    );
    await writeFile(
      path.join(cwd, "ios/App/SceneDelegate.swift"),
      "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
    );

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        native: {
          ios: { bundleProviderConfigured: true },
          issues: [],
        },
      },
    });
  });

  it.each(["secret", "local"])(
    "detects native signing keys that differ from the %s signing key",
    async (mode) => {
      const cwd = await createTempProject();
      tempProjects.push(cwd);
      mockGetCwd.mockReturnValue(cwd);
      mockReadPackageUp.mockResolvedValue({
        packageJson: {
          dependencies: {
            "hot-updater": "0.31.0",
            "@hot-updater/react-native": "0.31.0",
          },
        },
        path: path.join(cwd, "package.json"),
      });
      const configured = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const embedded = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      mockLoadConfig.mockResolvedValue(
        createConfig({
          signing:
            mode === "local"
              ? { enabled: true, privateKeyPath: "keys/private-key.pem" }
              : secret("bundle-signing-key"),
          secrets: holding({ "bundle-signing-key": configured.privateKey }),
          platform: {
            ios: {
              infoPlistPaths: ["ios/App/Info.plist"],
            },
            android: {
              androidManifestPaths: [
                "android/app/src/main/AndroidManifest.xml",
              ],
            },
          },
        }),
      );
      if (mode === "local") {
        await writeFile(
          path.join(cwd, "keys/private-key.pem"),
          configured.privateKey,
        );
      }
      await writeInfoPlist(
        cwd,
        [
          "<key>HOT_UPDATER_PUBLIC_KEY</key>",
          `<string>${embedded.publicKey.trim().replaceAll("\n", "\\n")}</string>`,
        ].join("\n"),
      );
      await writeFile(
        path.join(cwd, "ios/App/AppDelegate.swift"),
        "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
      );
      await writeAndroidManifest(
        cwd,
        `    <meta-data android:name="com.hotupdater.PUBLIC_KEY" android:value="${embedded.publicKey.trim().replaceAll("\n", "\\n")}" />`,
      );
      await writeFile(
        path.join(
          cwd,
          "android/app/src/main/java/com/example/MainApplication.kt",
        ),
        "import com.hotupdater.HotUpdater\nval bundle = HotUpdater.getJSBundleFile(applicationContext)\n",
      );

      const result = await doctor();

      expect(result).not.toBe(true);
      if (result !== true) {
        expect(result.details?.native?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "PUBLIC_KEY_MISMATCH",
              platform: "ios",
            }),
            expect.objectContaining({
              code: "PUBLIC_KEY_MISMATCH",
              platform: "android",
            }),
          ]),
        );
      }
    },
  );

  it("warns, instead of a mismatch, when the signer's public key cannot be read", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    const embedded = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    // A key this machine's secrets adapter lacks: the Secrets rows fail on
    // it, and the native keys go unchecked rather than mismatched.
    mockLoadConfig.mockResolvedValue(
      createConfig({
        signing: secret("bundle-signing-key"),
        secrets: holding({}),
        platform: {
          ios: { infoPlistPaths: ["ios/App/Info.plist"] },
          android: {
            androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
          },
        },
      }),
    );
    await writeInfoPlist(
      cwd,
      [
        "<key>HOT_UPDATER_PUBLIC_KEY</key>",
        `<string>${embedded.publicKey.trim().replaceAll("\n", "\\n")}</string>`,
      ].join("\n"),
    );
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
    );
    await writeAndroidManifest(
      cwd,
      `    <meta-data android:name="com.hotupdater.PUBLIC_KEY" android:value="${embedded.publicKey.trim().replaceAll("\n", "\\n")}" />`,
    );
    await writeFile(
      path.join(
        cwd,
        "android/app/src/main/java/com/example/MainApplication.kt",
      ),
      "import com.hotupdater.HotUpdater\nval bundle = HotUpdater.getJSBundleFile(applicationContext)\n",
    );

    const result = await doctor();

    const issues =
      result === true ? [] : (result.details?.native?.issues ?? []);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "SIGNING_PUBLIC_KEY_UNAVAILABLE",
        type: "warning",
        message: expect.stringContaining(
          "bundle-signing-key isn't in the team-store secrets adapter.",
        ),
      }),
    );
    expect(issues).not.toContainEqual(
      expect.objectContaining({ code: "PUBLIC_KEY_MISMATCH" }),
    );
  });

  it("shows a signing adapter as the error row deploy refuses with, checking no native key", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: { dependencies: { "hot-updater": "1.0.0" } },
      path: "/mock/cwd/package.json",
    });
    const getPublicKey = vi.fn();
    mockLoadConfig.mockResolvedValue(
      createConfig({
        signing: { name: "awsKmsSigning", getPublicKey, sign: vi.fn() },
      }),
    );

    const result = await doctor();

    expect(result).toMatchObject({
      success: false,
      details: {
        signing: {
          type: "error",
          message: 'signing takes secret("bundle-signing-key").',
          next: "Store your key:",
          command: "npx hot-updater secrets put bundle-signing-key <key.pem>",
        },
      },
    });
    expect(getPublicKey).not.toHaveBeenCalled();
  });

  it.each([
    ["the shorthand", () => secret("bundle-signing-key")],
    ["enabled: false", () => ({ enabled: false })],
  ])("shows no signing row for %s", async (_label, signing) => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: { dependencies: { "hot-updater": "1.0.0" } },
      path: "/mock/cwd/package.json",
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({ signing: signing(), secrets: holding({}) }),
    );

    const result = await doctor();

    expect(result).not.toHaveProperty("details.signing");
  });

  it("detects an Expo CNG trust anchor that differs from the signer", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    const signer = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const native = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        build: async () => ({
          build: vi.fn(),
          name: "expo",
          nativeBuild: {
            getBundleSigningPublicKey: async () => ({
              publicKey: native.publicKey,
            }),
          },
        }),
        signing: { enabled: true, privateKey: secret("bundle-signing-key") },
        secrets: holding({ "bundle-signing-key": signer.privateKey }),
      }),
    );

    const result = await doctor();

    expect(result).not.toBe(true);
    if (result !== true) {
      expect(result.details?.native?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "PUBLIC_KEY_MISMATCH" }),
        ]),
      );
    }
  });

  it("reports a leftover fingerprint.json without native folders or a signing hook", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        updateStrategy: "appVersion",
        build: async () => ({ build: vi.fn(), name: "bare" }),
      }),
    );
    await writeFile(path.join(cwd, "fingerprint.json"), "{}");

    const result = await doctor();

    expect(result).not.toBe(true);
    if (result !== true) {
      expect(result.details?.native?.issues).toEqual([
        expect.objectContaining({ code: "FINGERPRINT_JSON_UNUSED" }),
      ]);
    }
  });

  it("accepts Java Companion Android bundle provider calls", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        platform: {
          ios: {
            infoPlistPaths: ["ios/App/Info.plist"],
          },
          android: {
            androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
          },
        },
      }),
    );

    await writeInfoPlist(
      cwd,
      "<key>HOT_UPDATER_CHANNEL</key>\n<string>production</string>",
    );
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
    );
    await writeAndroidManifest(
      cwd,
      '    <meta-data android:name="com.hotupdater.CHANNEL" android:value="production" />',
    );
    await writeFile(
      path.join(
        cwd,
        "android/app/src/main/java/com/example/MainApplication.java",
      ),
      [
        "import com.hotupdater.HotUpdater;",
        "public class MainApplication {",
        "  protected String getJSBundleFile() {",
        "    return HotUpdater.Companion.getJSBundleFile(this.getApplication().getApplicationContext());",
        "  }",
        "}",
      ].join("\n"),
    );

    const result = await doctor();

    expect(result).toMatchObject({
      success: true,
      details: {
        native: {
          android: {
            channel: "production",
            bundleProviderConfigured: true,
          },
          issues: [],
        },
      },
    });
  });

  it("reports a fingerprint.json the appVersion strategy leaves, which builds would embed", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        updateStrategy: "appVersion",
        platform: {
          ios: {
            infoPlistPaths: ["ios/App/Info.plist"],
          },
          android: {
            androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
          },
        },
      }),
    );

    await writeFile(
      path.join(cwd, "fingerprint.json"),
      JSON.stringify({
        ios: { hash: "ios-fingerprint" },
        android: { hash: "android-fingerprint" },
      }),
    );
    await writeInfoPlist(
      cwd,
      [
        "<key>HOT_UPDATER_CHANNEL</key>",
        "<string>production</string>",
        "<key>HOT_UPDATER_FINGERPRINT_HASH</key>",
        "<string>stale-ios-fingerprint</string>",
      ].join("\n"),
    );
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
    );
    await writeAndroidManifest(
      cwd,
      [
        '    <meta-data android:name="com.hotupdater.CHANNEL" android:value="production" />',
        '    <meta-data android:name="com.hotupdater.FINGERPRINT_HASH" android:value="stale-android-fingerprint" />',
      ].join("\n"),
    );
    await writeFile(
      path.join(
        cwd,
        "android/app/src/main/java/com/example/MainApplication.kt",
      ),
      "import com.hotupdater.HotUpdater\nval bundle = HotUpdater.getJSBundleFile(applicationContext)\n",
    );

    const result = await doctor();

    expect(result).toMatchObject({
      success: false,
      details: {
        native: {
          updateStrategy: "appVersion",
          issues: [
            {
              platform: "project",
              code: "FINGERPRINT_JSON_UNUSED",
              paths: ["fingerprint.json"],
            },
          ],
        },
      },
    });
  });

  it("requires fingerprint.json for fingerprint strategy", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        updateStrategy: "fingerprint",
        platform: {
          ios: {
            infoPlistPaths: ["ios/App/Info.plist"],
          },
          android: {
            androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
          },
        },
      }),
    );

    await writeInfoPlist(
      cwd,
      "<key>HOT_UPDATER_CHANNEL</key>\n<string>production</string>",
    );
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
    );
    await writeAndroidManifest(
      cwd,
      '    <meta-data android:name="com.hotupdater.CHANNEL" android:value="production" />',
    );
    await writeFile(
      path.join(
        cwd,
        "android/app/src/main/java/com/example/MainApplication.kt",
      ),
      "import com.hotupdater.HotUpdater\nval bundle = HotUpdater.getJSBundleFile(applicationContext)\n",
    );

    const result = await doctor();

    expect(result).not.toBe(true);
    if (result !== true) {
      expect(result.success).toBe(false);
      expect(result.details?.native?.issues.map((issue) => issue.code)).toEqual(
        ["MISSING_FINGERPRINT_JSON"],
      );
      expect(
        result.details?.native?.issues.map((issue) => issue.resolution),
      ).toContain("Run `npx hot-updater fingerprint create`.");
      expect(
        result.details?.native?.issues.flatMap((issue) => issue.commands ?? []),
      ).toEqual(expect.arrayContaining(["npx hot-updater fingerprint create"]));
    }
  });

  it("needs no fingerprint hash in native files, which the build embeds", async () => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        updateStrategy: "fingerprint",
        platform: {
          ios: {
            infoPlistPaths: ["ios/App/Info.plist"],
          },
          android: {
            androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
          },
        },
      }),
    );

    await writeFile(
      path.join(cwd, "fingerprint.json"),
      JSON.stringify({
        ios: { hash: "ios-fingerprint" },
        android: { hash: "android-fingerprint" },
      }),
    );
    await writeInfoPlist(
      cwd,
      "<key>HOT_UPDATER_CHANNEL</key>\n<string>production</string>",
    );
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
    );
    await writeAndroidManifest(
      cwd,
      '    <meta-data android:name="com.hotupdater.CHANNEL" android:value="production" />',
    );
    await writeFile(
      path.join(
        cwd,
        "android/app/src/main/java/com/example/MainApplication.kt",
      ),
      "import com.hotupdater.HotUpdater\nval bundle = HotUpdater.getJSBundleFile(applicationContext)\n",
    );

    const result = await doctor();

    const codes =
      result === true
        ? []
        : (result.details?.native?.issues.map((issue) => issue.code) ?? []);
    expect(codes).not.toContain("MISSING_FINGERPRINT_HASH");
    expect(codes).not.toContain("FINGERPRINT_HASH_MISMATCH");
  });

  /** A React Native project with both platforms wired to Hot Updater. */
  const setUpNativeProject = async (
    updateStrategy: "appVersion" | "fingerprint",
  ) => {
    const cwd = await createTempProject();
    tempProjects.push(cwd);
    mockGetCwd.mockReturnValue(cwd);
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.31.0",
          "@hot-updater/react-native": "0.31.0",
        },
      },
      path: path.join(cwd, "package.json"),
    });
    mockLoadConfig.mockResolvedValue(
      createConfig({
        updateStrategy,
        platform: {
          ios: { infoPlistPaths: ["ios/App/Info.plist"] },
          android: {
            androidManifestPaths: ["android/app/src/main/AndroidManifest.xml"],
          },
        },
      }),
    );
    const fingerprint = updateStrategy === "fingerprint";
    await writeInfoPlist(
      cwd,
      fingerprint
        ? "<key>HOT_UPDATER_FINGERPRINT_HASH</key>\n<string>ios-fingerprint</string>"
        : "",
    );
    await writeFile(
      path.join(cwd, "ios/App/AppDelegate.swift"),
      "import HotUpdater\nfunc bundleURL() -> URL? { HotUpdater.bundleURL() }\n",
    );
    await writeAndroidManifest(
      cwd,
      fingerprint
        ? '    <meta-data android:name="com.hotupdater.FINGERPRINT_HASH" android:value="android-fingerprint" />'
        : "",
    );
    await writeFile(
      path.join(
        cwd,
        "android/app/src/main/java/com/example/MainApplication.kt",
      ),
      "import com.hotupdater.HotUpdater\nval bundle = HotUpdater.getJSBundleFile(applicationContext)\n",
    );
    if (fingerprint) {
      await writeFile(
        path.join(cwd, "fingerprint.json"),
        JSON.stringify({
          ios: { hash: "ios-fingerprint", sources: [] },
          android: { hash: "android-fingerprint", sources: [] },
        }),
      );
    }
    return cwd;
  };

  const staleIos: NativeCheckIssue = {
    type: "error",
    platform: "ios",
    code: "FINGERPRINT_JSON_STALE",
    message: "The iOS fingerprint changed since fingerprint.json was created.",
    resolution:
      "Run `npx hot-updater fingerprint create`, then rebuild the iOS app.",
    commands: ["npx hot-updater fingerprint create"],
    paths: ["fingerprint.json"],
    changes: { added: [], removed: [], changed: ["ios/App/AppDelegate.swift"] },
  };

  it("shows each platform's app version in the native status", async () => {
    await setUpNativeProject("appVersion");

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        native: {
          ios: { appVersion: "1.2.3" },
          android: { appVersion: "1.2.4" },
        },
      },
    });
  });

  it("compares fingerprint.json with the project's fingerprint and reports what changed", async () => {
    await setUpNativeProject("fingerprint");
    mockCheckFingerprintJson.mockResolvedValueOnce([staleIos]);

    const result = await doctor();

    expect(mockCheckFingerprintJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ios: expect.objectContaining({ hash: "ios-fingerprint" }),
      }),
      expect.any(Function),
    );
    expect(result).toMatchObject({
      success: false,
      details: { native: { issues: [staleIos] } },
    });
  });

  it("prints the sources that changed under a stale fingerprint.json", async () => {
    await setUpNativeProject("fingerprint");
    mockCheckFingerprintJson.mockResolvedValueOnce([staleIos]);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await handleDoctor({}).catch(() => {});

    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("iOS fingerprint changes\n"),
    );
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("ios/App/AppDelegate.swift"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
