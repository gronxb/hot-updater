import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { p, getCwd } from "@hot-updater/cli-tools";
import type { BuildAdapter } from "@hot-updater/plugin-core";
import {
  linesWiderThan,
  recordedClackCalls,
  renderClackLog,
} from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNativeBuild } from "./createNativeBuild";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(),
  p: { log: { info: vi.fn() } },
}));

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-native-"));
  vi.mocked(getCwd).mockReturnValue(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const buildAdapter = (calls: string[]): BuildAdapter => ({
  name: "bare",
  build: vi.fn(),
  nativeBuild: {
    postbuild: async ({ platform }) => {
      calls.push(`postbuild:${platform}`);
    },
  },
});

const writeArtifact = async (relativePath: string) => {
  const buildDirectory = path.join(root, "tmp-build");
  const artifact = path.join(buildDirectory, relativePath);
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, "artifact");
  return { buildDirectory, buildArtifactPath: artifact };
};

describe("createNativeBuild", () => {
  it("returns the artifact copied to the output path with the values the build compiled in", async () => {
    const calls: string[] = [];
    const outputPath = path.join(root, "output");
    const built = await writeArtifact("export/App.ipa");

    const result = await createNativeBuild({
      platform: "ios",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
      target: { fingerprintHash: null, appVersion: "1.2.0" },
      debug: false,
      readChannel: async () => "beta",
      outputPath,
      buildAdapter: buildAdapter(calls),
      builder: async () => {
        calls.push("build");
        return built;
      },
    });

    expect(calls).toEqual(["build", "postbuild:ios"]);
    expect(result).toEqual({
      platform: "ios",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
      channel: "beta",
      fingerprintHash: null,
      appVersion: "1.2.0",
      artifactPath: path.join(outputPath, "export/App.ipa"),
      artifactKind: "ipa",
    });
    await expect(fs.readFile(result.artifactPath, "utf-8")).resolves.toBe(
      "artifact",
    );
  });

  it.each([
    ["app-release.apk", "apk"],
    ["app-release.aab", "aab"],
    ["app/App.app", "app"],
  ] as const)("reports %s as an %s", async (artifact, kind) => {
    const built = await writeArtifact(artifact);

    const result = await createNativeBuild({
      platform: "android",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5",
      target: { fingerprintHash: "fingerprint", appVersion: null },
      debug: false,
      readChannel: async () => "production",
      outputPath: path.join(root, "output"),
      buildAdapter: buildAdapter([]),
      builder: async () => built,
    });

    expect(result.artifactKind).toBe(kind);
    expect(result.fingerprintHash).toBe("fingerprint");
  });

  it("reports the app version and channel the built app holds, over the project's", async () => {
    const built = await writeArtifact("export/App.ipa");
    const readChannel = vi.fn(async () => "production");

    const result = await createNativeBuild({
      platform: "ios",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
      // What the project files say, before an xcconfig overrides it.
      target: { fingerprintHash: null, appVersion: "1.0.0" },
      debug: false,
      readChannel,
      outputPath: path.join(root, "output"),
      buildAdapter: buildAdapter([]),
      builder: async () => ({
        ...built,
        builtApp: { appVersion: "2.0.0", channel: "beta", buildNumber: "66" },
      }),
    });

    expect(result).toMatchObject({
      appVersion: "2.0.0",
      fingerprintHash: null,
      channel: "beta",
      // The artifact's build number, which a store takes once.
      buildNumber: "66",
    });
    expect(readChannel).not.toHaveBeenCalled();
  });

  it("reports the default channel for a built app without one, and keeps the fingerprint", async () => {
    const built = await writeArtifact("app-release.aab");

    const result = await createNativeBuild({
      platform: "android",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5",
      target: { fingerprintHash: "fingerprint", appVersion: null },
      debug: false,
      readChannel: async () => "beta",
      outputPath: path.join(root, "output"),
      buildAdapter: buildAdapter([]),
      builder: async () => ({
        ...built,
        builtApp: { appVersion: "1.0.0", channel: null },
      }),
    });

    expect(result).toMatchObject({
      fingerprintHash: "fingerprint",
      appVersion: null,
      channel: "production",
    });
  });

  it("reports the project's channel when the artifact's cannot be read exactly", async () => {
    const built = await writeArtifact("app-release.apk");

    const result = await createNativeBuild({
      platform: "android",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5",
      target: { fingerprintHash: null, appVersion: "1.0.0" },
      debug: false,
      readChannel: async () => "from-project",
      outputPath: path.join(root, "output"),
      buildAdapter: buildAdapter([]),
      builder: async () => ({
        ...built,
        builtApp: { appVersion: "1.0.0", channel: undefined },
      }),
    });

    expect(result.channel).toBe("from-project");
  });

  it("reports the nil UUID a debug build's native SDK reports as its MIN_BUNDLE_ID", async () => {
    const built = await writeArtifact("app-debug.apk");

    const result = await createNativeBuild({
      platform: "android",
      scheme: "debugApk",
      minBundleId: "0190a1b2-c3d4-7000-8000-02a1b2c3d4e5",
      target: { fingerprintHash: null, appVersion: "1.0.0" },
      debug: true,
      readChannel: async () => "production",
      outputPath: path.join(root, "output"),
      buildAdapter: buildAdapter([]),
      builder: async () => built,
    });

    expect(result.minBundleId).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("disposes of the build's temporary directory once the artifact is copied out of it", async () => {
    const calls: string[] = [];
    const built = await writeArtifact("export/App.ipa");
    const outputPath = path.join(root, "output");

    const result = await createNativeBuild({
      platform: "ios",
      scheme: "release",
      minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
      target: { fingerprintHash: "fingerprint", appVersion: null },
      debug: false,
      readChannel: async () => "production",
      outputPath,
      buildAdapter: buildAdapter(calls),
      builder: async () => ({
        ...built,
        dispose: async () => {
          calls.push("dispose");
          await fs.rm(built.buildDirectory, { recursive: true, force: true });
        },
      }),
    });

    expect(calls).toEqual(["postbuild:ios", "dispose"]);
    await expect(fs.stat(built.buildDirectory)).rejects.toThrow();
    expect(result.artifactPath).toBe(path.join(outputPath, "export/App.ipa"));
    await expect(fs.readFile(result.artifactPath, "utf-8")).resolves.toBe(
      "artifact",
    );
  });

  it("disposes of the build's temporary directory when the postbuild fails", async () => {
    const built = await writeArtifact("export/App.ipa");
    const dispose = vi.fn(async () => {
      await fs.rm(built.buildDirectory, { recursive: true, force: true });
    });

    await expect(
      createNativeBuild({
        platform: "ios",
        scheme: "release",
        minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
        target: { fingerprintHash: "fingerprint", appVersion: null },
        debug: false,
        readChannel: async () => "production",
        outputPath: path.join(root, "output"),
        buildAdapter: {
          name: "bare",
          build: vi.fn(),
          nativeBuild: {
            postbuild: async () => {
              throw new Error("postbuild failed");
            },
          },
        },
        builder: async () => ({ ...built, dispose }),
      }),
    ).rejects.toThrow("postbuild failed");
    expect(dispose).toHaveBeenCalledOnce();
    await expect(fs.stat(built.buildDirectory)).rejects.toThrow();
  });

  it("rejects an artifact that is none of the kinds", async () => {
    const built = await writeArtifact("archive/App.xcarchive");

    await expect(
      createNativeBuild({
        platform: "ios",
        scheme: "release",
        minBundleId: "0190a1b2-c3d4-7000-8000-01a1b2c3d4e5",
        target: { fingerprintHash: "fingerprint", appVersion: null },
        debug: false,
        readChannel: async () => "production",
        outputPath: path.join(root, "output"),
        buildAdapter: buildAdapter([]),
        builder: async () => built,
      }),
    ).rejects.toThrow("Unexpected native build artifact");
  });
});

// No line the command prints wraps on an 80-column terminal.
afterEach(() => {
  expect(linesWiderThan(renderClackLog(recordedClackCalls(p.log, p)))).toEqual(
    [],
  );
});
