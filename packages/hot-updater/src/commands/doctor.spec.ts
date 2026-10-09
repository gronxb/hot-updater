import fs from "fs/promises";
import crypto from "node:crypto";
import os from "os";
import path from "path";

import { bare } from "@hot-updater/bare";
import {
  assembleServer,
  p,
  getCwd,
  loadConfig,
  readPackageUp,
} from "@hot-updater/cli-tools";
import {
  createMemoryAdapter,
  type ConfiguredDatabase,
} from "@hot-updater/plugin-core";
import { HOT_UPDATER_SERVER_VERSION } from "@hot-updater/server";
import { insights } from "@hot-updater/server/plugins";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { packageJsonData } from "../packageJson";
import {
  areVersionsCompatible,
  checkInfrastructureStatus,
  createInfrastructureRemediation,
  doctor,
  getRequiredInfrastructureVersion,
  getRequiredServerVersion,
  handleDoctor,
  isInfrastructureUpdateRequired,
  isV1InfrastructureRequired,
  resolveVersionEndpoint,
} from "./doctor";
import { checkFingerprintJson } from "./doctor/fingerprint";
import { applyDoctorFixes } from "./doctor/fix";
import type { DoctorFix, NativeCheckIssue } from "./doctor/issues";
import { getRequiredUpdateTarget } from "./doctorInfrastructureTargets";

vi.mock("../packageJson", () => ({ packageJsonData: { version: "1.0.0" } }));

// Computing a fingerprint hashes the whole project; doctor/fingerprint.spec
// covers the comparison itself.
vi.mock("./doctor/fingerprint", () => ({
  checkFingerprintJson: vi.fn(async () => []),
}));

vi.mock("../utils/version/getNativeAppVersion", () => ({
  getNativeAppVersion: vi.fn(async (platform: "ios" | "android") =>
    platform === "ios" ? "1.2.3" : "1.2.4",
  ),
}));

// The repairs write native files; doctor/fix.spec covers them.
vi.mock("./doctor/fix", () => ({
  applyDoctorFixes: vi.fn(async () => []),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  // The server doctor reads is assembled from the config as the CLI does.
  assembleServer: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).assembleServer,
  colors: (await importOriginal<typeof import("@hot-updater/cli-tools")>())
    .colors,
  getBundleSigningPublicKey: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).getBundleSigningPublicKey,
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
    },
  },
  resolvePackageVersion: (
    await importOriginal<typeof import("@hot-updater/cli-tools")>()
  ).resolvePackageVersion,
  readPackageUp: vi.fn(),
}));

const mockGetCwd = getCwd as ReturnType<typeof vi.fn>;
const mockCheckFingerprintJson = vi.mocked(checkFingerprintJson);
const mockApplyDoctorFixes = vi.mocked(applyDoctorFixes);
const mockLoadConfig = loadConfig as ReturnType<typeof vi.fn>;
const mockReadPackageUp = readPackageUp as ReturnType<typeof vi.fn>;

const createConfig = (overrides: Record<string, unknown> = {}) => ({
  build: async () => ({
    build: vi.fn(),
    name: "test-build",
  }),
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

const createReactNativeConfig = (
  cwd: string,
  overrides: Record<string, unknown> = {},
) =>
  createConfig({
    build: async () => ({
      build: vi.fn(),
      integration: bare({ enableHermes: true })({ cwd }).integration,
      name: "react-native-test-build",
    }),
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
    expect(areVersionsCompatible("1.0.0-rc.1", "1.0.0-rc.0")).toBe(true);
    expect(areVersionsCompatible("1.0.0-rc.0", "1.0.0-rc.1")).toBe(true);
    expect(areVersionsCompatible("1.0.1-rc.0", "1.0.0-rc.0")).toBe(false);
  });
});

describe("infrastructure version helpers", () => {
  it("resolves generation 1 as the only infrastructure target", () => {
    expect(getRequiredInfrastructureVersion("0.36.0")).toBe("1.0.0");
    expect(getRequiredInfrastructureVersion("1.0.0")).toBe("1.0.0");
    expect(getRequiredInfrastructureVersion("1.2.0")).toBe("1.0.0");
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
    ["1.0.0-rc.2", false],
    ["1.0.0-rc.1", true],
    ["1.0.0", false],
  ])(
    "checks server %s against the runtime shipped by the RC",
    async (serverVersion, needsUpdate) => {
      const requiredTarget = getRequiredUpdateTarget(
        "1.0.0-rc.4",
        "1.0.0-rc.2",
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
        requiredVersion: "1.0.0-rc.2",
        needsUpdate,
      });
      expect(status.upgradeBlocked).toBeUndefined();
    },
  );

  it("does not relax a stable CLI's requirement for an RC server", async () => {
    const requiredTarget = getRequiredUpdateTarget("1.0.0", "1.0.0-rc.2");
    const status = await checkInfrastructureStatus({
      serverBaseUrl: "https://updates.example.com",
      requiredTarget,
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ infrastructureGeneration: 1, version: "1.0.0-rc.2" }),
        ),
    });
    expect(status).toMatchObject({
      requiredVersion: "1.0.0",
      needsUpdate: true,
    });
  });

  it("does not relax the baseline for a different server core version", () => {
    expect(
      getRequiredUpdateTarget("1.0.0-rc.4", "0.99.0-rc.2"),
    ).not.toHaveProperty("minimumPrereleaseVersion");
  });

  it("still blocks a missing generation marker on the bundled RC runtime", async () => {
    const status = await checkInfrastructureStatus({
      serverBaseUrl: "https://updates.example.com",
      requiredTarget: getRequiredUpdateTarget("1.0.0-rc.4", "1.0.0-rc.2"),
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ version: "1.0.0-rc.2" })),
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
      fixability: "blocked",
      commands: expect.arrayContaining(["hot-updater agent infra upgrade"]),
    });
  });

  it("requires generation 1 for v1 packages", () => {
    expect(isV1InfrastructureRequired("0.38.0")).toBe(false);
    expect(isV1InfrastructureRequired("1.0.0")).toBe(true);
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
      fixability: "blocked",
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
    packageJsonData.version = "1.0.0";
    mockGetCwd.mockReturnValue("/mock/cwd");
    mockLoadConfig.mockResolvedValue(createConfig());
  });

  afterEach(async () => {
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
    expect(result).toBe(true);
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

    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ success: true }, null, 2),
    );
    expect(mockLoadConfig).toHaveBeenCalledWith(null);
    logSpy.mockRestore();
  });

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
    expect(result).toBe(true);
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
    expect(result).toBe(true);
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
        hotUpdaterVersion: "^0.18.2",
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
    expect(result).toBe(true);
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
        hotUpdaterVersion: "^1.0.0",
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

  it.each([
    ["compatible tarballs", "1.0.0-rc.14", true],
    ["incompatible tarballs", "2.0.0", false],
    ["uninstalled tarball", null, false],
  ] as const)(
    "checks installed versions for %s",
    async (_name, version, success) => {
      const cwd = await createTempProject();
      const packageName =
        version === null
          ? "@hot-updater/missing-test-integration"
          : "@hot-updater/lynx";
      try {
        for (const [name, installedVersion] of [
          ["hot-updater", "1.0.0-rc.16"],
          [packageName, version],
        ] as const) {
          if (installedVersion === null) continue;
          await writeFile(
            path.join(cwd, "node_modules", name, "package.json"),
            JSON.stringify({ name, version: installedVersion }),
          );
        }
        mockReadPackageUp.mockResolvedValue({
          packageJson: {
            dependencies: {
              "hot-updater": "file:./hot-updater.tgz",
              [packageName]: "file:./hot-updater-lynx.tgz",
            },
          },
          path: path.join(cwd, "package.json"),
        });
        const result = await doctor({ cwd });
        if (success) {
          expect(result).toBe(true);
        } else if (version === null) {
          expect(result).toMatchObject({
            success: false,
            error: expect.any(String),
          });
        } else {
          expect(result).toMatchObject({
            success: false,
            details: {
              hotUpdaterVersion: "1.0.0-rc.16",
              versionMismatches: [
                {
                  packageName: "@hot-updater/lynx",
                  currentVersion: "2.0.0",
                  expectedVersion: "1.0.0-rc.16",
                },
              ],
            },
          });
        }
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    },
  );

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
    expect(result).toBe(true);
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
    expect(result).toBe(true);
  });

  it("should accept independently released packages in the same RC", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.0.0-rc.0",
          "@hot-updater/cloudflare": "1.0.0-rc.0",
          "@hot-updater/expo": "1.0.0-rc.1",
          "@hot-updater/react-native": "1.0.0-rc.1",
        },
      },
      path: "/mock/cwd/package.json",
    });

    const result = await doctor();
    expect(result).toBe(true);
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
    expect(result).toBe(true);

    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        devDependencies: {
          "hot-updater": "1.0.0",
        },
      },
      path: "/mock/cwd/package.json",
    });
    const result2 = await doctor();
    expect(result2).toBe(true);

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

  it.each(["1.0.0-rc.4", "^1.0.0-rc.4", "~1.0.0-rc.4"])(
    "uses the executing CLI runtime rather than the %s dependency declaration",
    async (declaredVersion) => {
      packageJsonData.version = "1.0.0-rc.4";
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
            fixability: "blocked",
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
            fixability: "blocked",
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
                fixability: "auto",
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
              fixability: "blocked",
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
      createReactNativeConfig(cwd, {
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
      expect(
        result.details?.native?.issues.map((issue) => issue.fixability),
      ).toEqual(expect.arrayContaining(["auto"]));
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
      createReactNativeConfig(cwd, {
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

  it.each(["plugin", "local"])(
    "detects native signing keys that differ from the %s trust anchor",
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
      const getPublicKey = vi.fn();
      mockLoadConfig.mockResolvedValue(
        createConfig({
          signing:
            mode === "local"
              ? { enabled: true, privateKeyPath: "keys/private-key.pem" }
              : {
                  name: "doctor-provider-test",
                  getPublicKey: getPublicKey.mockResolvedValue({
                    publicKey: configured.publicKey,
                  }),
                  sign: vi.fn(),
                },
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
      expect(getPublicKey).toHaveBeenCalledTimes(mode === "plugin" ? 1 : 0);
    },
  );

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
        signing: {
          getPublicKey: async () => ({ publicKey: signer.publicKey }),
          name: "test-provider",
          sign: vi.fn(),
        },
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
      createReactNativeConfig(cwd, {
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

  it("ignores fingerprint.json when update strategy is appVersion", async () => {
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
      success: true,
      details: {
        native: {
          updateStrategy: "appVersion",
          issues: [],
        },
      },
    });
  });

  it("requires fingerprint.json and native hashes for fingerprint strategy", async () => {
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
        [
          "MISSING_FINGERPRINT_HASH",
          "MISSING_FINGERPRINT_HASH",
          "MISSING_FINGERPRINT_JSON",
        ],
      );
      expect(
        result.details?.native?.issues.map((issue) => issue.resolution),
      ).toContain("Run `npx hot-updater fingerprint create`.");
      expect(
        result.details?.native?.issues.map((issue) => issue.fixability),
      ).toEqual(["command", "command", "command"]);
      expect(
        result.details?.native?.issues.flatMap((issue) => issue.commands ?? []),
      ).toEqual(expect.arrayContaining(["npx hot-updater fingerprint create"]));
    }
  });

  it("requires fingerprint hashes in native files when fingerprint.json exists", async () => {
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

    expect(result).not.toBe(true);
    if (result !== true) {
      expect(result.success).toBe(false);
      expect(result.details?.native?.issues.map((issue) => issue.code)).toEqual(
        ["MISSING_FINGERPRINT_HASH", "MISSING_FINGERPRINT_HASH"],
      );
    }
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
    fixability: "command",
    commands: ["npx hot-updater fingerprint create"],
    paths: ["fingerprint.json"],
    changes: { added: [], removed: [], changed: ["ios/App/AppDelegate.swift"] },
  };

  const fingerprintFix: DoctorFix = {
    repair: "fingerprint",
    codes: ["FINGERPRINT_JSON_STALE"],
    status: "applied",
    wrote: ["fingerprint.json", "ios/App/Info.plist"],
    native: true,
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
      expect.stringContaining("iOS Fingerprint Changes:"),
    );
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("ios/App/AppDelegate.swift"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("runs --fix's repairs, checks again, and lists every file they wrote", async () => {
    await setUpNativeProject("fingerprint");
    mockCheckFingerprintJson
      .mockResolvedValueOnce([staleIos])
      .mockResolvedValueOnce([]);
    mockApplyDoctorFixes.mockResolvedValueOnce([fingerprintFix]);

    const result = await doctor({ fix: true });

    expect(mockApplyDoctorFixes).toHaveBeenCalledWith(
      [staleIos],
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(mockCheckFingerprintJson).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      details: { fixes: [fingerprintFix], native: { issues: [] } },
    });
  });

  it("runs no repair in scoped verification, even when asked to fix", async () => {
    const result = await doctor({
      fix: true,
      scope: "scaffold",
      infraDir: "/missing/infra",
    });

    expect(mockApplyDoctorFixes).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { verification: {} } });
    expect(result).not.toHaveProperty("details.fixes");
  });

  it("reports no fixes when --fix finds nothing to repair", async () => {
    await setUpNativeProject("appVersion");

    const result = await doctor({ fix: true });

    expect(mockApplyDoctorFixes).toHaveBeenCalledWith([], expect.anything());
    expect(result).toMatchObject({ success: true, details: { fixes: [] } });
  });

  it("ends by asking for a native rebuild when --fix wrote native files", async () => {
    await setUpNativeProject("fingerprint");
    mockCheckFingerprintJson
      .mockResolvedValueOnce([staleIos])
      .mockResolvedValueOnce([]);
    mockApplyDoctorFixes.mockResolvedValueOnce([fingerprintFix]);

    await handleDoctor({ fix: true });

    expect(p.log.success).toHaveBeenCalledWith(
      "Fixed: Recreate fingerprint.json and the native fingerprint hashes.",
    );
    expect(p.outro).toHaveBeenLastCalledWith(
      "Rebuild the native app: doctor --fix changed its native files.",
    );
  });
});
