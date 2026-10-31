import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCwd, loadConfig, p } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAndInjectFingerprintFiles } from "@/utils/fingerprint";
import { resolveNativeAppVersion } from "@/utils/version/getNativeAppVersion";

import { prepareNativeBuild } from "./prepareNativeBuild";

const spinner = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
  loadConfig: vi.fn(),
  p: {
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), step: vi.fn() },
    spinner: () => spinner,
    select: vi.fn(),
    isCancel: () => false,
  },
}));
vi.mock("@/utils/version/getNativeAppVersion", () => ({
  resolveNativeAppVersion: vi.fn(async () => ({ version: "1.0.0" })),
}));
vi.mock("@/utils/version/appVersionCandidates", () => ({
  formatAppVersionCandidates: vi.fn(),
  isAmbiguousAppVersion: vi.fn(() => false),
}));
vi.mock("@/utils/fingerprint", () => ({
  createAndInjectFingerprintFiles: vi.fn(),
  isFingerprintEquals: vi.fn(),
  readLocalFingerprint: vi.fn(),
}));

let project: string;
const calls: string[] = [];
const buildAdapter = {
  name: "bare",
  build: vi.fn(),
  nativeBuild: {
    prebuild: vi.fn(async () => {
      calls.push("prebuild");
    }),
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  calls.length = 0;
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-build-"));
  vi.mocked(getCwd).mockReturnValue(project);
  vi.mocked(loadConfig).mockResolvedValue({
    updateStrategy: "appVersion",
    nativeBuild: {
      ios: { release: { scheme: "App", simulator: true } },
      android: {},
    },
    build: () => buildAdapter,
  } as unknown as Awaited<ReturnType<typeof loadConfig>>);
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe("prepareNativeBuild", () => {
  it("names --scheme instead of asking for one under -i without a terminal", async () => {
    const stdinIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: undefined,
    });
    try {
      await expect(
        prepareNativeBuild({
          platform: "ios",
          interactive: true,
        } as Parameters<typeof prepareNativeBuild>[0]),
      ).resolves.toBeNull();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: stdinIsTTY,
      });
      process.exitCode = undefined;
    }
    expect(p.select).not.toHaveBeenCalled();
    expect(p.log.error).toHaveBeenCalledWith(
      "Which scheme do you use to build?\nRe-run with --scheme <release> in a non-interactive shell.",
    );
    expect(calls).toEqual([]);
  });

  it("refuses an appVersion build that would embed a leftover fingerprint.json", async () => {
    await fs.writeFile(path.join(project, "fingerprint.json"), "{}");

    await expect(
      prepareNativeBuild({
        platform: "ios",
        scheme: "release",
        interactive: false,
      } as Parameters<typeof prepareNativeBuild>[0]),
    ).resolves.toBeNull();
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("fingerprint.json exists"),
    );
    expect(resolveNativeAppVersion).not.toHaveBeenCalled();
  });

  it("returns the scheme and the app version an appVersion build compiles in, read after the adapter's prebuild", async () => {
    vi.mocked(resolveNativeAppVersion).mockImplementationOnce(async () => {
      calls.push("resolveNativeAppVersion");
      return { version: "1.0.0" } as Awaited<
        ReturnType<typeof resolveNativeAppVersion>
      >;
    });

    await expect(
      prepareNativeBuild({
        platform: "ios",
        scheme: "release",
        interactive: false,
      }),
    ).resolves.toMatchObject({
      scheme: "release",
      target: { fingerprintHash: null, appVersion: "1.0.0" },
      outputPath: path.join(
        project,
        ".hot-updater",
        "output",
        "build",
        "ios",
        "release",
      ),
    });
    expect(vi.mocked(loadConfig).mock.calls).toEqual([
      [{ platform: "ios", channel: "" }],
    ]);
    expect(spinner.start).toHaveBeenCalledWith("Reading the iOS app version");
    expect(spinner.stop).toHaveBeenCalledWith("iOS app version 1.0.0");
  });

  it("stops on the missing app version, not on a null one, before its error", async () => {
    vi.mocked(resolveNativeAppVersion).mockResolvedValueOnce({
      version: null,
    } as unknown as Awaited<ReturnType<typeof resolveNativeAppVersion>>);

    await prepareNativeBuild({
      platform: "ios",
      scheme: "release",
      interactive: false,
    });

    expect(spinner.stop).toHaveBeenCalledWith("No iOS app version found");
    expect(p.log.error).toHaveBeenCalled();
  });

  it("hands the scheme to beforePrebuild before the adapter's prebuild, which a failing check skips", async () => {
    const beforePrebuild = vi.fn(async () => {
      calls.push("beforePrebuild");
    });

    await prepareNativeBuild({
      platform: "ios",
      scheme: "release",
      interactive: false,
      beforePrebuild,
    });

    expect(beforePrebuild).toHaveBeenCalledWith({
      scheme: "release",
      iosScheme: { scheme: "App", simulator: true },
    });
    expect(calls).toEqual(["beforePrebuild", "prebuild"]);

    await expect(
      prepareNativeBuild({
        platform: "ios",
        scheme: "release",
        interactive: false,
        beforePrebuild: async () => {
          throw new Error("TestFlight takes an .ipa");
        },
      }),
    ).rejects.toThrow("TestFlight takes an .ipa");
    expect(buildAdapter.nativeBuild.prebuild).toHaveBeenCalledTimes(1);
  });

  it("refuses an iOS device scheme it cannot export as an .ipa, before the adapter's prebuild", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      updateStrategy: "appVersion",
      nativeBuild: { ios: { release: { scheme: "App" } }, android: {} },
      build: () => buildAdapter,
    } as unknown as Awaited<ReturnType<typeof loadConfig>>);

    await expect(
      prepareNativeBuild({
        platform: "ios",
        scheme: "release",
        interactive: false,
      }),
    ).resolves.toBeNull();
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "nativeBuild.ios.release builds for devices, and can't export an .ipa.",
      ),
    );
    expect(buildAdapter.nativeBuild.prebuild).not.toHaveBeenCalled();
  });

  it("returns the fingerprint a fingerprint build compiles in", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      updateStrategy: "fingerprint",
      nativeBuild: {
        ios: {},
        android: { release: { packageName: "com.example" } },
      },
      build: () => buildAdapter,
    } as unknown as Awaited<ReturnType<typeof loadConfig>>);
    vi.mocked(createAndInjectFingerprintFiles).mockResolvedValue({
      fingerprint: { android: { hash: "android-hash", sources: [] } },
    } as unknown as Awaited<
      ReturnType<typeof createAndInjectFingerprintFiles>
    >);

    await expect(
      prepareNativeBuild({
        platform: "android",
        scheme: "release",
        interactive: false,
      }),
    ).resolves.toMatchObject({
      scheme: "release",
      target: { fingerprintHash: "android-hash", appVersion: null },
      androidSchemeConfig: { variant: "Release", aab: true },
    });
    expect(resolveNativeAppVersion).not.toHaveBeenCalled();
    expect(spinner.stop).toHaveBeenCalledWith(
      "Android fingerprint android-hash",
    );
  });
});

// The terminal these specs simulate takes prompts only outside CI, and CI
// runners set CI.
beforeEach(() => {
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
