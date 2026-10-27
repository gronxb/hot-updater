import { stripVTControlCharacters } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => "/project",
  p: { log: { info: vi.fn(), success: vi.fn(), warn: vi.fn() } },
}));
vi.mock("../setChannel", () => ({
  getChannel: vi.fn(async () => ({ value: "production" })),
}));
vi.mock("./buildKey", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./buildKey")>()),
  computeNativeBuildKey: vi.fn(),
}));
vi.mock("./nativeBuildCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nativeBuildCache")>()),
  findCachedNativeBuild: vi.fn(),
  markCachedNativeBuildTracked: vi.fn(async () => {}),
  saveCachedNativeBuild: vi.fn(async () => {}),
}));

import { p } from "@hot-updater/cli-tools";

import {
  computeNativeBuildKey,
  type NativeBuildKeyComponents,
} from "./buildKey";
import type { NativeBuildResult } from "./createNativeBuild";
import {
  findCachedNativeBuild,
  markCachedNativeBuildTracked,
  saveCachedNativeBuild,
} from "./nativeBuildCache";
import { reuseNativeBuild } from "./reuseNativeBuild";

const KEY = `nbk1:${"a".repeat(64)}`;
const components = (
  files: Record<string, string>,
  env: Record<string, string> = {},
): NativeBuildKeyComponents => ({
  engine: "hot-updater/native-build@2",
  files,
  inputs: {},
  autolinking: {},
  settings: {},
  signing: {},
  toolchain: {},
  env,
});
const result: NativeBuildResult = {
  platform: "android",
  scheme: "release",
  minBundleId: "019a0000-0000-7000-8000-0000000000c1",
  channel: "production",
  fingerprintHash: null,
  appVersion: "1.0.0",
  artifactPath: "/project/out/app.apk",
  artifactKind: "apk",
};

const reuse = (noCache = false) =>
  reuseNativeBuild({
    platform: "android",
    scheme: "release",
    cacheDir: "node_modules/.hot-updater",
    outputPath: "/project/out",
    target: { fingerprintHash: null, appVersion: "1.0.0" },
    androidScheme: {
      aab: false,
      variant: "Release",
      appModuleName: "app",
      packageName: "com.app",
      applicationId: "com.app",
      hotUpdaterSchemeName: "release",
    },
    credentials: { resolve: vi.fn() },
    noCache,
  });

const lines = (log: (message: string) => void) =>
  vi
    .mocked(log)
    .mock.calls.map(([message]) => stripVTControlCharacters(String(message)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeNativeBuildKey).mockResolvedValue({
    key: KEY,
    components: components({ "src/App.tsx": "2" }, { EXPO_PUBLIC_A: "2" }),
    uncacheable: null,
  });
});

describe("reuseNativeBuild", () => {
  it("says what changed since this machine's cached build when nothing has the key", async () => {
    vi.mocked(findCachedNativeBuild).mockResolvedValueOnce({
      hit: null,
      cached: {
        version: 1,
        key: `nbk1:${"b".repeat(64)}`,
        components: components({ "src/App.tsx": "1" }, { EXPO_PUBLIC_A: "1" }),
        build: result,
        nativeBuildId: null,
      },
      missingArtifact: null,
      takenMinBundleId: false,
    });

    const cache = await reuse();

    expect(cache.hit).toBeNull();
    expect(cache.report).toEqual({
      hit: null,
      key: KEY,
      uncacheable: null,
      changed: ["file:src/App.tsx", "env:EXPO_PUBLIC_A"],
    });
    expect(lines(p.log.info)).toEqual([
      "Building: no tracked build has this key; changed since this machine's cached build: src/App.tsx, $EXPO_PUBLIC_A (key nbk1:aaaaaaaaaaaa…)",
    ]);
    expect(findCachedNativeBuild).toHaveBeenCalledWith({
      key: KEY,
      scheme: "release",
      slot: "/project/node_modules/.hot-updater/native-build/android/release",
      predictedScope: {
        platform: "android",
        channel: "production",
        fingerprintHash: null,
        appVersion: "1.0.0",
      },
      outputPath: "/project/out",
    });
  });

  it("builds, saying why, when another build registered the MIN_BUNDLE_ID of this machine's cached build", async () => {
    vi.mocked(findCachedNativeBuild).mockResolvedValueOnce({
      hit: null,
      cached: {
        version: 1,
        key: KEY,
        components: components({}),
        build: result,
        nativeBuildId: null,
      },
      missingArtifact: null,
      takenMinBundleId: true,
    });

    const cache = await reuse();

    expect(cache.hit).toBeNull();
    expect(lines(p.log.info)).toEqual([
      `Building: this machine's cached build with this key has the MIN_BUNDLE_ID ${result.minBundleId}, which another native build registered first (key nbk1:aaaaaaaaaaaa…)`,
    ]);
  });

  it("reuses a tracked build, keeping it on this machine for the next run", async () => {
    const nativeBuild = { id: "build-1", min_bundle_id: result.minBundleId };
    vi.mocked(findCachedNativeBuild).mockResolvedValueOnce({
      hit: { source: "storage", nativeBuild: nativeBuild as never, result },
      cached: null,
      missingArtifact: null,
      takenMinBundleId: false,
    });

    const cache = await reuse();

    expect(cache.report.hit).toBe("storage");
    expect(lines(p.log.success)[0]).toBe(
      "Reusing native build build-1 (key nbk1:aaaaaaaaaaaa…; storage)\n    Artifact: out/app.apk",
    );
    expect(saveCachedNativeBuild).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY, nativeBuildId: "build-1" }),
    );
  });

  it("marks this machine's copy tracked when the reused build is it", async () => {
    const nativeBuild = { id: "build-1", min_bundle_id: result.minBundleId };
    vi.mocked(findCachedNativeBuild).mockResolvedValueOnce({
      hit: { source: "storage", nativeBuild: nativeBuild as never, result },
      cached: {
        version: 1,
        key: KEY,
        components: components({}),
        build: result,
        nativeBuildId: null,
      },
      missingArtifact: null,
      takenMinBundleId: false,
    });

    await reuse();

    expect(saveCachedNativeBuild).not.toHaveBeenCalled();
    expect(markCachedNativeBuildTracked).toHaveBeenCalledWith(
      "/project/node_modules/.hot-updater/native-build/android/release",
      KEY,
      "build-1",
    );
  });

  it("builds without looking up a build no key covers, or with --no-cache", async () => {
    vi.mocked(computeNativeBuildKey).mockResolvedValueOnce({
      key: null,
      components: null,
      uncacheable: "a Debug build loads its JavaScript from Metro",
    });
    expect((await reuse()).report).toEqual({
      hit: null,
      key: null,
      uncacheable: "a Debug build loads its JavaScript from Metro",
      changed: [],
    });

    const noCache = await reuse(true);
    expect(noCache.report).toMatchObject({
      key: KEY,
      uncacheable: "--no-cache",
    });
    expect(findCachedNativeBuild).not.toHaveBeenCalled();
    expect(lines(p.log.info)[0]).toBe(
      "Building: no build can be reused, as a Debug build loads its JavaScript from Metro.",
    );
    // The new build is still cached with its key.
    await noCache.remember(result, null);
    expect(saveCachedNativeBuild).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY, build: result }),
    );
  });

  it("builds when the key can't be computed or the lookup fails", async () => {
    vi.mocked(computeNativeBuildKey).mockRejectedValueOnce(
      new Error("git crashed"),
    );
    expect((await reuse()).report.uncacheable).toBe(
      "the native build key could not be computed (git crashed)",
    );

    vi.mocked(findCachedNativeBuild).mockRejectedValueOnce(
      new Error("storage unreachable"),
    );
    expect((await reuse()).hit).toBeNull();
    expect(lines(p.log.warn)[0]).toBe(
      "Building: the build with key nbk1:aaaaaaaaaaaa… could not be reused: storage unreachable",
    );
  });
});
