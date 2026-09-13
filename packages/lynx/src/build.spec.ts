import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  lynx,
  type LynxBuildContext,
  type LynxBuildOutput,
  MAX_LYNX_RUNTIME_ID_UTF8_BYTES,
  MAX_LYNX_SIDECAR_BYTES,
} from "./build";

describe("framework-independent Lynx artifacts", () => {
  let cwd: string;
  const runtimeId = "native-profile-test-v1";
  const binary = Buffer.from([0xff, 0x00, 0x80, 0x42]);
  const build =
    vi.fn<(context: LynxBuildContext) => Promise<LynxBuildOutput>>();

  beforeEach(async () => {
    build.mockReset();
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-lynx-"));
    build.mockImplementation(async ({ outDir }) => {
      await fs.mkdir(path.join(outDir, "templates"));
      await fs.writeFile(path.join(outDir, "templates/main.bin"), binary);
      await fs.writeFile(
        path.join(outDir, "templates/lazy.bundle"),
        "lazy chunk",
      );
      await fs.writeFile(path.join(outDir, "icon.png"), "image");
      return {
        entry: "templates/main.bin",
        runtimeId,
        stdout: "compiler output",
      };
    });
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("preserves opaque entry bytes, extra bundles and assets with independent OS identities", async () => {
    const builder = lynx({ build })({ cwd });
    const ios = await builder.build({ platform: "ios" });
    const android = await builder.build({ platform: "android" });
    expect(ios.bundleId).not.toBe(android.bundleId);
    expect(ios.buildPath).not.toBe(android.buildPath);
    for (const [result, platform] of [
      [ios, "ios"],
      [android, "android"],
    ] as const) {
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(result.buildPath, "hot-updater-lynx.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        schemaVersion: 1,
        bundleId: result.bundleId,
        platform,
        entry: "templates/main.bin",
        runtimeId,
      });
      expect(result.patchAssetPath).toBe("templates/main.bin");
      expect(result.artifacts).toEqual(
        expect.arrayContaining([
          {
            path: path.join(result.buildPath, "templates/main.bin"),
            name: "templates/main.bin",
            downloadCompression: "br",
          },
          {
            path: path.join(result.buildPath, "templates/lazy.bundle"),
            name: "templates/lazy.bundle",
            downloadCompression: null,
          },
          {
            path: path.join(result.buildPath, "icon.png"),
            name: "icon.png",
            downloadCompression: null,
          },
          {
            path: path.join(result.buildPath, "hot-updater-lynx.json"),
            name: "hot-updater-lynx.json",
            downloadCompression: null,
          },
        ]),
      );
      expect(
        await fs.readFile(path.join(result.buildPath, "templates/main.bin")),
      ).toEqual(binary);
      expect(
        await fs.readFile(
          path.join(result.buildPath, "templates/lazy.bundle"),
          "utf8",
        ),
      ).toBe("lazy chunk");
      expect(
        await fs.readFile(path.join(result.buildPath, "icon.png"), "utf8"),
      ).toBe("image");
      expect(result.stdout).toBe("compiler output");
      expect(build).toHaveBeenCalledWith({
        cwd,
        platform,
        bundleId: result.bundleId,
        outDir: result.buildPath,
      });
    }
  });

  it("orders artifact names by locale-independent UTF-16 code units", async () => {
    build.mockImplementation(async ({ outDir }) => {
      await Promise.all([
        fs.writeFile(path.join(outDir, "Z.asset"), "upper"),
        fs.writeFile(path.join(outDir, "ä.asset"), "non-ascii"),
        fs.writeFile(path.join(outDir, "main.bundle"), binary),
      ]);
      return { entry: "main.bundle", runtimeId };
    });

    const result = await lynx({ build })({ cwd }).build({ platform: "ios" });

    expect(result.artifacts.map(({ name }) => name)).toEqual([
      "Z.asset",
      "hot-updater-lynx.json",
      "main.bundle",
      "ä.asset",
    ]);
  });

  it("resolves the native build's public key lazily with the application directory", async () => {
    const publicKeyPath = path.join(cwd, "native-public.pem");
    await fs.writeFile(publicKeyPath, "native public key");
    const resolveKey = vi.fn(async ({ cwd }: { cwd: string }) => ({
      publicKey: await fs.readFile(path.join(cwd, "native-public.pem"), "utf8"),
    }));
    const plugin = lynx({ build, getBundleSigningPublicKey: resolveKey })({
      cwd,
    });
    expect(resolveKey).not.toHaveBeenCalled();
    expect(plugin.nativeBuild?.signingConfigSource).toBe("build-plugin");
    await expect(
      plugin.nativeBuild!.getBundleSigningPublicKey!(),
    ).resolves.toEqual({
      publicKey: "native public key",
    });
    expect(resolveKey).toHaveBeenCalledWith({ cwd });
    expect(build).not.toHaveBeenCalled();
  });

  it("declares an absent native trust anchor instead of falling back to RN configuration", async () => {
    const plugin = lynx({ build })({ cwd });
    expect(plugin.nativeBuild?.signingConfigSource).toBe("build-plugin");
    await expect(
      plugin.nativeBuild!.getBundleSigningPublicKey!(),
    ).resolves.toBeNull();
  });

  it("propagates a native key resolver failure before invoking compilation", async () => {
    const failure = new Error("Native key configuration is unavailable");
    const plugin = lynx({
      build,
      getBundleSigningPublicKey: async () => {
        throw failure;
      },
    })({ cwd });
    await expect(plugin.nativeBuild!.getBundleSigningPublicKey!()).rejects.toBe(
      failure,
    );
    expect(build).not.toHaveBeenCalled();
  });

  it.each([".", "..", "../outside"])(
    "rejects unsafe output root %s before invoking the compiler",
    async (outDir) => {
      await expect(
        lynx({ build, outDir })({ cwd }).build({ platform: "ios" }),
      ).rejects.toThrow("subdirectory");
      expect(build).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "../entry.bundle",
    "/entry.bundle",
    "a/../entry.bundle",
    "C:/entry.bundle",
    "a\\entry.bundle",
    "a//entry.bundle",
  ])(
    "rejects an unsafe returned entry %j and removes only the failed attempt",
    async (entry) => {
      const previous = await lynx({ build })({ cwd }).build({
        platform: "ios",
      });
      build.mockResolvedValue({ entry, runtimeId });
      await expect(
        lynx({ build })({ cwd }).build({ platform: "ios" }),
      ).rejects.toThrow("relative file path");
      expect(await fs.readdir(path.dirname(previous.buildPath))).toEqual([
        path.basename(previous.buildPath),
      ]);
    },
  );

  it.each(["missing", "empty", "directory"])(
    "rejects a %s entry",
    async (kind) => {
      build.mockImplementation(async ({ outDir }) => {
        if (kind === "empty")
          await fs.writeFile(path.join(outDir, "main.bundle"), "");
        if (kind === "directory")
          await fs.mkdir(path.join(outDir, "main.bundle"));
        return { entry: "main.bundle", runtimeId };
      });
      await expect(
        lynx({ build })({ cwd }).build({ platform: "ios" }),
      ).rejects.toThrow();
      expect(await fs.readdir(path.join(cwd, ".hot-updater/lynx"))).toEqual([]);
    },
  );

  it("rejects linked assets that could include files outside the artifact", async () => {
    await fs.writeFile(path.join(cwd, "outside.txt"), "private");
    build.mockImplementation(async ({ outDir }) => {
      await fs.writeFile(path.join(outDir, "main.bundle"), binary);
      await fs.symlink(
        path.join(cwd, "outside.txt"),
        path.join(outDir, "linked.txt"),
      );
      return { entry: "main.bundle", runtimeId };
    });
    await expect(
      lynx({ build })({ cwd }).build({ platform: "ios" }),
    ).rejects.toThrow("symbolic links");
    expect(await fs.readFile(path.join(cwd, "outside.txt"), "utf8")).toBe(
      "private",
    );
  });

  it("propagates compiler failure without disturbing a successful artifact", async () => {
    const previous = await lynx({ build })({ cwd }).build({
      platform: "android",
    });
    const failure = new Error("Compiler failed");
    build.mockImplementation(async ({ outDir }) => {
      await fs.writeFile(path.join(outDir, "partial.bundle"), "partial");
      throw failure;
    });
    await expect(
      lynx({ build })({ cwd }).build({ platform: "android" }),
    ).rejects.toBe(failure);
    expect(await fs.readdir(path.dirname(previous.buildPath))).toEqual([
      path.basename(previous.buildPath),
    ]);
  });

  it.each([undefined, "", "   ", 1])(
    "rejects an absent or invalid native profile %j",
    async (invalid) => {
      build.mockImplementation(async ({ outDir }) => {
        await fs.writeFile(path.join(outDir, "main.bundle"), binary);
        return { entry: "main.bundle", runtimeId: invalid } as LynxBuildOutput;
      });
      await expect(
        lynx({ build })({ cwd }).build({ platform: "ios" }),
      ).rejects.toThrow("native compatibility identity");
      expect(await fs.readdir(path.join(cwd, ".hot-updater/lynx"))).toEqual([]);
    },
  );

  it("accepts the runtime identity boundary within the native sidecar cap", async () => {
    build.mockImplementation(async ({ outDir }) => {
      await fs.writeFile(path.join(outDir, "main.bundle"), binary);
      return {
        entry: "main.bundle",
        runtimeId: "\0".repeat(MAX_LYNX_RUNTIME_ID_UTF8_BYTES),
      };
    });

    const result = await lynx({ build })({ cwd }).build({ platform: "ios" });
    const metadata = await fs.readFile(
      path.join(result.buildPath, "hot-updater-lynx.json"),
    );
    expect(metadata.byteLength).toBeLessThanOrEqual(MAX_LYNX_SIDECAR_BYTES);
  });

  it("rejects a runtime identity one byte above the sidecar-safe boundary", async () => {
    build.mockImplementation(async ({ outDir }) => {
      await fs.writeFile(path.join(outDir, "main.bundle"), binary);
      return {
        entry: "main.bundle",
        runtimeId: "r".repeat(MAX_LYNX_RUNTIME_ID_UTF8_BYTES + 1),
      };
    });

    await expect(
      lynx({ build })({ cwd }).build({ platform: "ios" }),
    ).rejects.toThrow(`exceeds ${MAX_LYNX_RUNTIME_ID_UTF8_BYTES} UTF-8 bytes`);
  });

  it.each([
    ["manifest.json", "file"],
    ["manifest.json", "directory"],
    ["hot-updater-lynx.json", "file"],
    ["hot-updater-lynx.json", "directory"],
    ["MANIFEST.JSON", "file"],
    ["HOT-UPDATER-LYNX.JSON", "file"],
  ])(
    "rejects reserved input %s (%s) without changing an earlier build",
    async (name, kind) => {
      const previous = await lynx({ build })({ cwd }).build({
        platform: "ios",
      });
      build.mockImplementation(async ({ outDir }) => {
        await fs.writeFile(path.join(outDir, "main.bundle"), binary);
        if (kind === "directory") await fs.mkdir(path.join(outDir, name));
        else await fs.writeFile(path.join(outDir, name), "producer metadata");
        return { entry: "main.bundle", runtimeId };
      });
      await expect(
        lynx({ build })({ cwd }).build({ platform: "ios" }),
      ).rejects.toThrow("reserved");
      expect(await fs.readdir(path.dirname(previous.buildPath))).toEqual([
        path.basename(previous.buildPath),
      ]);
      expect(
        await fs.readFile(path.join(previous.buildPath, "templates/main.bin")),
      ).toEqual(binary);
    },
  );

  it("rejects an output root linked outside the app before running the compiler", async () => {
    const outside = await fs.mkdtemp(`${cwd}-outside-`);
    try {
      await fs.symlink(outside, path.join(cwd, "linked"));
      await expect(
        lynx({ build, outDir: "linked" })({ cwd }).build({ platform: "ios" }),
      ).rejects.toThrow("subdirectory");
      expect(build).not.toHaveBeenCalled();
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
