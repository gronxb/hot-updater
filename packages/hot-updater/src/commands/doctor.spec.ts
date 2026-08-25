import fs from "fs/promises";
import os from "os";
import path from "path";

import { getCwd, loadConfig, readPackageUp } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabasePluginHarness } from "./databasePlugin.testFixtures";
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

vi.mock("@hot-updater/cli-tools", () => ({
  getCwd: vi.fn(() => "/mock/cwd"),
  loadConfig: vi.fn(),
  p: {},
  readPackageUp: vi.fn(),
}));

const mockGetCwd = getCwd as ReturnType<typeof vi.fn>;
const mockLoadConfig = loadConfig as ReturnType<typeof vi.fn>;
const mockReadPackageUp = readPackageUp as ReturnType<typeof vi.fn>;
const doctorDatabaseHarness = createDatabasePluginHarness();

const createConfig = (overrides: Record<string, unknown> = {}) => ({
  updateStrategy: "appVersion",
  platform: {
    ios: {
      infoPlistPaths: [],
    },
    android: {
      androidManifestPaths: [],
    },
  },
  database: doctorDatabaseHarness.plugin,
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
  it("should ignore patch differences for package versions", () => {
    expect(areVersionsCompatible("1.0.0", "1.0.1")).toBe(true);
    expect(areVersionsCompatible("0.31.4", "0.31.9")).toBe(true);
    expect(areVersionsCompatible("^0.31.4", "0.31.9")).toBe(true);
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

  it("resolves the version endpoint from the server base URL", () => {
    expect(resolveVersionEndpoint("https://example.com/api/check-update")).toBe(
      "https://example.com/api/check-update/version",
    );
    expect(
      resolveVersionEndpoint("https://example.com/api/check-update/"),
    ).toBe("https://example.com/api/check-update/version");
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
      commands: ["hot-updater init"],
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
          "@hot-updater/core": "^0.18.2",
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
    expect(mockLoadConfig).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("should return true for a healthy setup", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "0.18.2",
          "@hot-updater/core": "^0.18.2",
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
          "@hot-updater/core": "0.18.2",
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
          "@hot-updater/core": "0.17.0",
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
          "@hot-updater/core",
          "@hot-updater/react-native",
        ],
        packageJsonPath: "/mock/cwd/package.json",
        versionMismatches: [
          {
            currentVersion: "0.17.0",
            expectedVersion: "^0.18.2",
            packageName: "@hot-updater/core",
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
          "@hot-updater/core": "1.0.1",
          "@hot-updater/plugin-react-native": "1.0.5",
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
          "@hot-updater/core": "1.0.0",
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
          "@hot-updater/core": "2.0.0",
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
          "@hot-updater/core",
          "@hot-updater/plugin-A",
          "@hot-updater/plugin-B",
        ],
        versionMismatches: [
          {
            packageName: "@hot-updater/core",
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
    expect(result).toBe(true);
  });

  it("should not report package mismatches for patch differences", async () => {
    mockReadPackageUp.mockResolvedValue({
      packageJson: {
        dependencies: {
          "hot-updater": "1.0.0",
          "@hot-updater/core": "1.0.1",
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
            commands: ["hot-updater init"],
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
            commands: ["hot-updater init"],
          },
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
});
