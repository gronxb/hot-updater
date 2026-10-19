import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCwd, loadConfig, p } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAndInjectFingerprintFiles } from "@/utils/fingerprint";
import { resolveNativeAppVersion } from "@/utils/version/getNativeAppVersion";

import { prepareNativeBuild } from "./prepareNativeBuild";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
  loadConfig: vi.fn(),
  p: {
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
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
    nativeBuild: { ios: { release: { scheme: "App" } }, android: {} },
    build: () => buildAdapter,
  } as unknown as Awaited<ReturnType<typeof loadConfig>>);
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe("prepareNativeBuild", () => {
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
  });
});
