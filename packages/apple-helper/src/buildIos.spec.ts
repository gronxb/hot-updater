import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CredentialResolver } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const { createMinBundleId, isCI, parseSecretReference, secret } =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    createMinBundleId,
    isCI,
    parseSecretReference,
    secret,
    getCwd: () => root,
    p: {
      log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
});
vi.mock("./utils/readBuiltApp", () => ({
  readBuiltApp: vi.fn(async (appPath: string) => ({
    appVersion: "2.0.0",
    channel: appPath,
  })),
}));
vi.mock("execa", () => ({
  // plutil reading an exportOptionsPlist's method: the file holds it.
  execa: vi.fn(async (_file: string, args: string[]) => ({
    exitCode: 0,
    stdout: await fs.readFile(args.at(-1)!, "utf-8"),
  })),
}));
// The build's directories are made under root, which each test removes.
vi.mock("./utils/createRandomTmpDir", () => ({
  createRandomTmpDir: vi.fn(async () => fs.mkdtemp(path.join(root, "tmp-"))),
  removeTmpDir: vi.fn(async (directory: string) =>
    fs.rm(directory, { recursive: true, force: true }),
  ),
}));
vi.mock("./utils/ciSigningKeychain", () => ({
  withSigningKeychain: vi.fn(async ({ run }: { run: () => Promise<unknown> }) =>
    run(),
  ),
}));
vi.mock("./utils/assertXcodebuildExist", () => ({
  assertXcodebuildExist: vi.fn(),
}));
vi.mock("./builder/buildXcodeProject", () => ({
  buildXcodeProject: vi.fn(
    async ({ outputDirectory }: { outputDirectory: string }) => {
      const appPath = path.join(outputDirectory, "App.app");
      await fs.mkdir(appPath, { recursive: true });
      return { appPath };
    },
  ),
}));
vi.mock("./builder/archiveXcodeProject", () => ({
  archiveXcodeProject: vi.fn(
    async ({ archiveDirectory }: { archiveDirectory: string }) => {
      const archivePath = path.join(archiveDirectory, "App.xcarchive");
      await fs.mkdir(
        path.join(archivePath, "Products", "Applications", "App.app"),
        { recursive: true },
      );
      return { archivePath };
    },
  ),
}));
/** The export options each export read, before their directory is removed. */
let exportOptions: string[];
vi.mock("./builder/exportXcodeArchive", () => ({
  exportXcodeArchive: vi.fn(
    async ({
      exportPath,
      exportOptionsPlist,
    }: {
      exportPath: string;
      exportOptionsPlist: string;
    }) => {
      exportOptions.push(
        await fs.readFile(exportOptionsPlist, "utf-8").catch(() => ""),
      );
      await fs.mkdir(exportPath, { recursive: true });
      await fs.writeFile(path.join(exportPath, "App.ipa"), "ipa");
      return { exportPath };
    },
  ),
}));

vi.mock("./utils/sandboxInfoPlist", () => ({
  patchSandboxArchive: vi.fn(),
  patchSandboxSimulatorApp: vi.fn(),
}));

import { secret } from "@hot-updater/cli-tools";

import { archiveXcodeProject } from "./builder/archiveXcodeProject";
import { buildXcodeProject } from "./builder/buildXcodeProject";
import { exportXcodeArchive } from "./builder/exportXcodeArchive";
import { buildIos } from "./buildIos";
import { withSigningKeychain } from "./utils/ciSigningKeychain";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";
import { readBuiltApp } from "./utils/readBuiltApp";
import {
  patchSandboxArchive,
  patchSandboxSimulatorApp,
} from "./utils/sandboxInfoPlist";

const MIN_BUNDLE_ID = "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5";

const scheme = (
  overrides: Partial<EnrichedNativeBuildIosScheme> = {},
): EnrichedNativeBuildIosScheme => ({
  bundleIdentifier: "com.example",
  scheme: "App",
  platform: "ios",
  installPods: false,
  configuration: "Release",
  destination: [],
  simulator: false,
  hotUpdaterSchemeName: "release",
  ...overrides,
});

const ascKeyResolver = () => {
  const resolve = vi.fn(async () => ({
    keyPath: "/tmp/AuthKey_ABC.p8",
    keyId: "ABC",
    issuerId: "issuer",
  }));
  return { resolve: resolve as typeof resolve & CredentialResolver["resolve"] };
};

const AUTHENTICATION_ARGS = [
  "-allowProvisioningUpdates",
  "-authenticationKeyPath",
  "/tmp/AuthKey_ABC.p8",
  "-authenticationKeyID",
  "ABC",
  "-authenticationKeyIssuerID",
  "issuer",
];

beforeEach(async () => {
  vi.clearAllMocks();
  exportOptions = [];
  root = await fs.mkdtemp(path.join(os.tmpdir(), "apple-helper-spec-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("buildIos of a sandbox scheme", () => {
  const plan = {
    updateStrategy: "fingerprint",
    train: { highestClosedVersion: "1.6.2", highestBuildNumber: 68 },
  } as const;

  it("compiles the layer in, and patches the simulator app before reading it", async () => {
    await buildIos({
      schemeConfig: scheme({ simulator: true, sandbox: true }),
      minBundleId: MIN_BUNDLE_ID,
    });

    expect(buildXcodeProject).toHaveBeenCalledWith(
      expect.objectContaining({ sandbox: true }),
    );
    const [patched] = vi.mocked(patchSandboxSimulatorApp).mock
      .invocationCallOrder;
    const [read] = vi.mocked(readBuiltApp).mock.invocationCallOrder;
    expect(patched).toBeLessThan(read!);
  });

  it("patches the archive before it copies the app out and exports, internal testing only", async () => {
    await buildIos({
      schemeConfig: scheme({
        sandbox: true,
        signing: { ascApiKey: secret("asc-api-key") },
      }),
      minBundleId: MIN_BUNDLE_ID,
      credentials: ascKeyResolver(),
      sandbox: plan,
    });

    expect(archiveXcodeProject).toHaveBeenCalledWith(
      expect.objectContaining({ sandbox: true }),
    );
    expect(patchSandboxArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        plan,
        appPath: expect.stringMatching(/Products\/Applications\/App\.app$/),
      }),
    );
    const [patched] = vi.mocked(patchSandboxArchive).mock.invocationCallOrder;
    const [exported] = vi.mocked(exportXcodeArchive).mock.invocationCallOrder;
    const [read] = vi.mocked(readBuiltApp).mock.invocationCallOrder;
    expect(patched).toBeLessThan(read!);
    expect(patched).toBeLessThan(exported!);
    expect(exportOptions[0]).toContain("testFlightInternalTestingOnly");
  });

  it("never patches or marks a normal scheme's build", async () => {
    await buildIos({
      schemeConfig: scheme({ signing: { ascApiKey: secret("asc-api-key") } }),
      minBundleId: MIN_BUNDLE_ID,
      credentials: ascKeyResolver(),
    });
    await buildIos({
      schemeConfig: scheme({ simulator: true }),
      minBundleId: MIN_BUNDLE_ID,
    });

    expect(patchSandboxArchive).not.toHaveBeenCalled();
    expect(patchSandboxSimulatorApp).not.toHaveBeenCalled();
    expect(exportOptions[0]).not.toContain("testFlightInternalTestingOnly");
    expect(
      vi.mocked(archiveXcodeProject).mock.calls[0]![0].sandbox,
    ).toBeFalsy();
  });
});

describe("buildIos", () => {
  it("builds a simulator .app without resolving signing credentials", async () => {
    const credentials = ascKeyResolver();

    const { buildDirectory, buildArtifactPath, builtApp } = await buildIos({
      schemeConfig: scheme({
        simulator: true,
        signing: { ascApiKey: secret("asc-api-key") },
      }),
      minBundleId: MIN_BUNDLE_ID,
      credentials,
    });

    expect(buildArtifactPath).toBe(path.join(buildDirectory, "app", "App.app"));
    // Read from the built app.
    expect(builtApp).toEqual({
      appVersion: "2.0.0",
      channel: buildArtifactPath,
    });
    expect(buildXcodeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceType: "simulator",
        minBundleId: MIN_BUNDLE_ID,
      }),
    );
    expect(vi.mocked(buildXcodeProject).mock.calls[0]![0]).not.toHaveProperty(
      "authenticationArgs",
    );
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(archiveXcodeProject).not.toHaveBeenCalled();
  });

  it("archives and exports an .ipa with the scheme's export options and the project's signing", async () => {
    const credentials = ascKeyResolver();
    const exportOptionsPlist = path.join(root, "ExportOptions.plist");

    const { buildDirectory, buildArtifactPath, builtApp } = await buildIos({
      schemeConfig: scheme({ exportOptionsPlist }),
      minBundleId: MIN_BUNDLE_ID,
      credentials,
    });

    expect(buildArtifactPath).toBe(
      path.join(buildDirectory, "export", "App.ipa"),
    );
    // Read from the archived app the .ipa exports.
    expect(builtApp?.channel).toBe(
      path.join(buildDirectory, "archive", "App.app"),
    );
    expect(archiveXcodeProject).toHaveBeenCalledWith(
      expect.objectContaining({
        minBundleId: MIN_BUNDLE_ID,
        authenticationArgs: undefined,
      }),
    );
    expect(exportXcodeArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        exportOptionsPlist,
        authenticationArgs: undefined,
      }),
    );
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it("signs the archive and the export with the scheme's App Store Connect API key", async () => {
    const credentials = ascKeyResolver();

    const { buildArtifactPath } = await buildIos({
      schemeConfig: scheme({ signing: { ascApiKey: secret("app-store-key") } }),
      minBundleId: MIN_BUNDLE_ID,
      credentials,
    });

    expect(buildArtifactPath.endsWith("App.ipa")).toBe(true);
    expect(credentials.resolve).toHaveBeenCalledOnce();
    expect(credentials.resolve).toHaveBeenCalledWith({
      kind: "asc-api-key",
      name: "app-store-key",
    });
    expect(archiveXcodeProject).toHaveBeenCalledWith(
      expect.objectContaining({ authenticationArgs: AUTHENTICATION_ARGS }),
    );
    const [{ authenticationArgs, exportOptionsPlist }] =
      vi.mocked(exportXcodeArchive).mock.calls[0]!;
    expect(authenticationArgs).toEqual(AUTHENTICATION_ARGS);
    // Without exportOptionsPlist, it exports for App Store Connect.
    expect(exportOptions[0]).toContain("<string>app-store-connect</string>");
    expect(exportOptions[0]).toContain("<string>automatic</string>");
    // The export options are written to a directory the export removes.
    await expect(fs.stat(path.dirname(exportOptionsPlist))).rejects.toThrow();
  });

  it.each([
    ["true", true],
    ["", false],
  ])(
    "archives and exports in a keychain of the build's own only in CI (CI=%j)",
    async (ci, enabled) => {
      vi.stubEnv("CI", ci);
      const credentials = ascKeyResolver();

      await buildIos({
        schemeConfig: scheme({
          signing: { ascApiKey: secret("app-store-key") },
        }),
        minBundleId: MIN_BUNDLE_ID,
        credentials,
      });

      expect(withSigningKeychain).toHaveBeenCalledOnce();
      expect(withSigningKeychain).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled,
          apiKey: {
            keyPath: "/tmp/AuthKey_ABC.p8",
            keyId: "ABC",
            issuerId: "issuer",
          },
        }),
      );
      expect(archiveXcodeProject).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["app-store-connect", true],
    ["development", false],
    ["release-testing", true],
    ["ad-hoc", true],
  ])(
    "in CI, signs a %s export with the API key in a keychain of its own: %s",
    async (method, enabled) => {
      vi.stubEnv("CI", "true");
      const exportOptionsPlist = path.join(root, "ExportOptions.plist");
      // The mocked plutil prints the file: its method.
      await fs.writeFile(exportOptionsPlist, method);

      await buildIos({
        schemeConfig: scheme({
          exportOptionsPlist,
          signing: { ascApiKey: secret("app-store-key") },
        }),
        minBundleId: MIN_BUNDLE_ID,
        credentials: ascKeyResolver(),
      });

      expect(withSigningKeychain).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled,
          // A certificate that may have signed an ad hoc .ipa stays valid.
          keepDistribution: ["release-testing", "ad-hoc"].includes(method),
        }),
      );
      expect(exportXcodeArchive).toHaveBeenCalledWith(
        expect.objectContaining({ authenticationArgs: AUTHENTICATION_ARGS }),
      );
    },
  );

  it("leaves only the .ipa of an export, so no log with its bearer token reaches the output or the cache", async () => {
    vi.mocked(exportXcodeArchive).mockImplementationOnce(
      async ({ exportPath }: { exportPath: string }) => {
        await fs.mkdir(path.join(exportPath, "App.xcdistributionlogs"), {
          recursive: true,
        });
        await Promise.all(
          [
            "App.ipa",
            "Packaging.log",
            "DistributionSummary.plist",
            "ExportOptions.plist",
            "App.xcdistributionlogs/IDEDistribution.verbose.log",
          ].map((file) =>
            fs.writeFile(
              path.join(exportPath, file),
              'Authorization = "Bearer eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJhIn0.c2lnbmF0dXJl"',
            ),
          ),
        );
        return { exportPath };
      },
    );

    const { buildDirectory, buildArtifactPath, dispose } = await buildIos({
      schemeConfig: scheme({
        signing: { ascApiKey: secret("app-store-key") },
      }),
      minBundleId: MIN_BUNDLE_ID,
      credentials: ascKeyResolver(),
    });

    const files = await fs.readdir(buildDirectory, { recursive: true });
    expect(
      files.filter((file) => /log|Summary|ExportOptions/iu.test(file)),
    ).toEqual([]);
    expect(path.basename(buildArtifactPath)).toBe("App.ipa");
    expect(files).toContain(path.join("export", "App.ipa"));
    await dispose();
  });

  it("needs no keychain of its own for a build with the project's signing", async () => {
    vi.stubEnv("CI", "true");
    const exportOptionsPlist = path.join(root, "ExportOptions.plist");
    await fs.writeFile(exportOptionsPlist, "<plist/>");

    await buildIos({
      schemeConfig: scheme({ exportOptionsPlist }),
      minBundleId: MIN_BUNDLE_ID,
      credentials: ascKeyResolver(),
    });

    expect(withSigningKeychain).not.toHaveBeenCalled();
    expect(exportXcodeArchive).toHaveBeenCalledOnce();
  });

  it("returns the archive of a device build it cannot export", async () => {
    const credentials = ascKeyResolver();

    const { buildDirectory, buildArtifactPath } = await buildIos({
      schemeConfig: scheme(),
      minBundleId: MIN_BUNDLE_ID,
      credentials,
    });

    expect(buildArtifactPath).toBe(
      path.join(buildDirectory, "archive", "App.xcarchive"),
    );
    expect(exportXcodeArchive).not.toHaveBeenCalled();
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it("issues a MIN_BUNDLE_ID with zero random bits without one, as the podspec script phase does", async () => {
    await buildIos({ schemeConfig: scheme({ simulator: true }) });

    expect(vi.mocked(buildXcodeProject).mock.calls[0]![0].minBundleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-000000000000$/,
    );
  });
});
