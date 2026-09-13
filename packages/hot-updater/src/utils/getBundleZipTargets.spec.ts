import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import { createTarBrTargetFiles } from "@hot-updater/cli-tools";
import {
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_EXPANDED_BYTES,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBundleManifest,
  writeBundleManifestFile,
} from "./bundleManifest";
import { getBundleZipTargets } from "./getBundleZipTargets";

describe("getBundleZipTargets", () => {
  let directory: string;
  let buildPath: string;

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "opaque-build-")),
    );
    buildPath = path.join(directory, "build");
    await fs.mkdir(buildPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("preserves explicit opaque names and download representations", async () => {
    const selected = [
      {
        path: path.join(buildPath, "compiler-output.data"),
        name: "runtime/main.opaque",
        downloadCompression: "br" as const,
      },
      {
        path: path.join(buildPath, "dependency.map"),
        name: "assets/dependency.map",
        downloadCompression: null,
      },
    ];
    await fs.writeFile(selected[0]!.path, "entry");
    await fs.writeFile(selected[1]!.path, "runtime dependency");

    const snapshot = await getBundleZipTargets(buildPath, selected);

    expect(snapshot.path).toContain(".hot-updater-snapshot-");
    expect(snapshot.expandedByteSize).toBe(
      Buffer.byteLength("entry") + Buffer.byteLength("runtime dependency"),
    );
    expect(
      snapshot.artifacts.map(({ downloadCompression, name }) => ({
        downloadCompression,
        name,
      })),
    ).toEqual(
      selected.map(({ downloadCompression, name }) => ({
        downloadCompression,
        name,
      })),
    );
    await expect(
      fs.readFile(snapshot.artifacts[0]!.path, "utf8"),
    ).resolves.toBe("entry");
    await expect(
      fs.readFile(snapshot.artifacts[1]!.path, "utf8"),
    ).resolves.toBe("runtime dependency");
  });

  it("does not infer React Native filtering or renaming", async () => {
    const js = path.join(buildPath, "index.ios.bundle");
    const hbc = path.join(buildPath, "index.ios.bundle.hbc");
    const map = path.join(buildPath, "index.ios.bundle.map");
    await Promise.all([
      fs.writeFile(js, "js"),
      fs.writeFile(hbc, "hbc"),
      fs.writeFile(map, "map"),
    ]);

    const selected = [
      { path: js, name: "js.bin", downloadCompression: null },
      { path: hbc, name: "bytecode.bin", downloadCompression: "br" as const },
      { path: map, name: "runtime.map", downloadCompression: null },
    ];
    const snapshot = await getBundleZipTargets(buildPath, selected);
    expect(
      snapshot.artifacts.map(({ downloadCompression, name }) => ({
        downloadCompression,
        name,
      })),
    ).toEqual(
      selected.map(({ downloadCompression, name }) => ({
        downloadCompression,
        name,
      })),
    );
  });

  it("uses one immutable snapshot after the producer replaces its output", async () => {
    const originalPath = path.join(buildPath, "compiler-output.data");
    await fs.writeFile(originalPath, "trusted runtime");
    const snapshot = await getBundleZipTargets(buildPath, [
      {
        path: originalPath,
        name: "runtime/main.opaque",
        downloadCompression: null,
      },
    ]);

    await fs.writeFile(originalPath, "untrusted replacement");
    const manifest = await createBundleManifest({
      bundleId: "bundle-id",
      patchAssetPath: "runtime/main.opaque",
      targetFiles: snapshot.artifacts,
    });
    const manifestPath = await writeBundleManifestFile({
      buildPath: snapshot.path,
      manifest,
    });
    const archivePath = path.join(directory, "bundle.tar.br");
    await createTarBrTargetFiles({
      outfile: archivePath,
      targetFiles: [
        ...snapshot.artifacts,
        { path: manifestPath, name: "manifest.json" },
      ],
    });

    expect(manifest.assets["runtime/main.opaque"]?.fileHash).toBe(
      crypto.createHash("sha256").update("trusted runtime").digest("hex"),
    );
    const archive = brotliDecompressSync(await fs.readFile(archivePath));
    expect(archive.includes(Buffer.from("trusted runtime"))).toBe(true);
    expect(archive.includes(Buffer.from("untrusted replacement"))).toBe(false);
  });

  it("rejects a stable replacement triggered by the visible snapshot path", async () => {
    const firstPath = path.join(buildPath, "first.bin");
    const secondPath = path.join(buildPath, "second.bin");
    const replacement = "evil payload!!";
    await fs.writeFile(firstPath, "trusted first");
    await fs.writeFile(secondPath, "trusted second");
    const originalMkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
      const snapshotPath = await originalMkdtemp(...args);
      await fs.rm(secondPath);
      await fs.writeFile(secondPath, replacement);
      return snapshotPath;
    });

    await expect(
      getBundleZipTargets(buildPath, [
        { path: firstPath, name: "first.bin", downloadCompression: null },
        { path: secondPath, name: "second.bin", downloadCompression: null },
      ]),
    ).rejects.toThrow("Build artifact changed during snapshot");

    await expect(fs.readFile(secondPath, "utf8")).resolves.toBe(replacement);
    expect(
      (await fs.readdir(buildPath)).filter((name) =>
        name.startsWith(".hot-updater-snapshot-"),
      ),
    ).toEqual([]);
  });

  it("removes a completed snapshot when closing a held source fails", async () => {
    const entry = path.join(buildPath, "entry.bin");
    await fs.writeFile(entry, "trusted");
    const originalOpen = fs.open.bind(fs);
    let closeSource: (() => Promise<void>) | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === entry) {
        closeSource = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockRejectedValueOnce(
          new Error("source close failed"),
        );
      }
      return handle;
    });

    await expect(
      getBundleZipTargets(buildPath, [
        { path: entry, name: "entry.bin", downloadCompression: null },
      ]),
    ).rejects.toThrow("source close failed");
    expect(
      (await fs.readdir(buildPath)).filter((name) =>
        name.startsWith(".hot-updater-snapshot-"),
      ),
    ).toEqual([]);
    await closeSource?.();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a file replaced by a symlink between validation and open",
    async () => {
      const originalPath = path.join(buildPath, "entry.bin");
      const outsidePath = path.join(directory, "outside.bin");
      await fs.writeFile(originalPath, "trusted");
      await fs.writeFile(outsidePath, "outside");
      const originalLstat = fs.lstat.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await originalLstat(...args);
        if (String(args[0]) === originalPath && !replaced) {
          replaced = true;
          await fs.rm(originalPath);
          await fs.symlink(outsidePath, originalPath, "file");
        }
        return stat;
      });

      await expect(
        getBundleZipTargets(buildPath, [
          {
            path: originalPath,
            name: "entry.bin",
            downloadCompression: null,
          },
        ]),
      ).rejects.toThrow();
    },
  );

  it.each(["file", "directory"])(
    "rejects a reserved root manifest %s even when omitted",
    async (kind) => {
      const entry = path.join(buildPath, "entry.bin");
      await fs.writeFile(entry, "entry");
      const reserved = path.join(buildPath, "manifest.json");
      if (kind === "directory") await fs.mkdir(reserved);
      else await fs.writeFile(reserved, "compiler metadata");
      await expect(
        getBundleZipTargets(buildPath, [
          { path: entry, name: "entry.bin", downloadCompression: null },
        ]),
      ).rejects.toThrow("reserved manifest.json");
    },
  );

  it.each([
    "../entry.bin",
    "/entry.bin",
    "a/../entry.bin",
    "C:/entry.bin",
    "a\\entry.bin",
    "a//entry.bin",
    "a/./entry.bin",
  ])("rejects noncanonical logical name %s", async (name) => {
    const entry = path.join(buildPath, "entry.bin");
    await fs.writeFile(entry, "entry");
    await expect(
      getBundleZipTargets(buildPath, [
        { path: entry, name, downloadCompression: null },
      ]),
    ).rejects.toThrow("Invalid build artifact name");
  });

  it.each(["MANIFEST.JSON", "manifeſt.json", "MANIFEST.JSON/entry"])(
    "rejects portable reserved manifest alias %s",
    async (name) => {
      const entry = path.join(buildPath, "entry.bin");
      await fs.writeFile(entry, "entry");
      await expect(
        getBundleZipTargets(buildPath, [
          { path: entry, name, downloadCompression: null },
        ]),
      ).rejects.toThrow("reserved manifest.json");
    },
  );

  it.each([
    ["case", "Asset.bin", "asset.bin"],
    ["NFC and NFD", "café.png", "cafe\u0301.png"],
    ["full case fold sharp s", "Straße.png", "STRASSE.png"],
    ["full case fold final sigma", "μέρος.png", "ΜΈΡΟσ.png"],
  ])(
    "rejects portable %s name collisions",
    async (_, firstName, secondName) => {
      const first = path.join(buildPath, "first");
      const second = path.join(buildPath, "second");
      await fs.writeFile(first, "first");
      await fs.writeFile(second, "second");
      await expect(
        getBundleZipTargets(buildPath, [
          { path: first, name: firstName, downloadCompression: null },
          { path: second, name: secondName, downloadCompression: null },
        ]),
      ).rejects.toThrow("Duplicate build artifact name");
    },
  );

  it.each([
    ["direct order", "runtime", "runtime/entry.lynxbc"],
    ["reverse order", "runtime/entry.lynxbc", "runtime"],
    ["portable case", "Runtime", "runtime/entry.lynxbc"],
    ["portable NFC", "café", "cafe\u0301/entry.lynxbc"],
    ["portable full case fold", "Straße", "strasse/entry.lynxbc"],
  ])(
    "rejects file and descendant conflicts in %s",
    async (_, firstName, secondName) => {
      const first = path.join(buildPath, "first");
      const second = path.join(buildPath, "second");
      await fs.writeFile(first, "first");
      await fs.writeFile(second, "second");

      await expect(
        getBundleZipTargets(buildPath, [
          { path: first, name: firstName, downloadCompression: null },
          { path: second, name: secondName, downloadCompression: null },
        ]),
      ).rejects.toThrow("conflict as file and descendant");
    },
  );

  it.each([
    ["portable case", "A/x.bin", "a/y.bin"],
    ["portable NFC", "café/x.bin", "cafe\u0301/y.bin"],
    ["portable full case fold", "Straße/x.bin", "strasse/y.bin"],
  ])(
    "rejects implicit parent directory collisions in %s",
    async (_, firstName, secondName) => {
      const first = path.join(buildPath, "first");
      const second = path.join(buildPath, "second");
      await fs.writeFile(first, "first");
      await fs.writeFile(second, "second");

      await expect(
        getBundleZipTargets(buildPath, [
          { path: first, name: firstName, downloadCompression: null },
          { path: second, name: secondName, downloadCompression: null },
        ]),
      ).rejects.toThrow("directories have a portable name collision");
    },
  );

  it("accepts 1024 UTF-8 path bytes and rejects 1025", async () => {
    const entry = path.join(buildPath, "entry.bin");
    await fs.writeFile(entry, "entry");
    const maxName = [
      "a".repeat(200),
      "b".repeat(200),
      "c".repeat(200),
      "d".repeat(200),
      "é".repeat(110),
    ].join("/");
    expect(Buffer.byteLength(maxName)).toBe(1024);

    const snapshot = await getBundleZipTargets(buildPath, [
      { path: entry, name: maxName, downloadCompression: null },
    ]);
    expect(snapshot.artifacts[0]?.name).toBe(maxName);

    await expect(
      getBundleZipTargets(buildPath, [
        {
          path: entry,
          name: `${maxName}a`,
          downloadCompression: null,
        },
      ]),
    ).rejects.toThrow("exceeds 1024 UTF-8 bytes");
  });

  it("rejects 10,000 declared artifacts before reading their paths", async () => {
    const artifacts = Array.from({ length: 10_000 }, (_, index) => ({
      path: path.join(buildPath, `missing-${index}`),
      name: `file-${index}`,
      downloadCompression: null,
    }));

    await expect(getBundleZipTargets(buildPath, artifacts)).rejects.toThrow(
      "more than 9999 artifacts",
    );
  });

  it("rejects 5,000 unique directory assets as 10,001 archive entries", async () => {
    const artifacts = Array.from({ length: 5_000 }, (_, index) => ({
      path: path.join(buildPath, `missing-${index}`),
      name: `dir-${index}/entry`,
      downloadCompression: null,
    }));

    await expect(getBundleZipTargets(buildPath, artifacts)).rejects.toThrow(
      "more than 10000 entries",
    );
  });

  it("rejects a source file one byte above the native per-file limit", async () => {
    const entry = path.join(buildPath, "entry.bin");
    await fs.writeFile(entry, "");
    await fs.truncate(entry, MAX_BUNDLE_ARTIFACT_BYTES + 1);

    await expect(
      getBundleZipTargets(buildPath, [
        { path: entry, name: "entry.bin", downloadCompression: null },
      ]),
    ).rejects.toThrow(`exceeds ${MAX_BUNDLE_ARTIFACT_BYTES} bytes`);
    expect(
      (await fs.readdir(buildPath)).filter((name) =>
        name.startsWith(".hot-updater-snapshot-"),
      ),
    ).toEqual([]);
  });

  it("rejects source files one byte above the native expanded-total limit", async () => {
    const artifacts = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const filePath = path.join(buildPath, `entry-${index}.bin`);
        await fs.writeFile(filePath, "");
        await fs.truncate(filePath, index < 4 ? MAX_BUNDLE_ARTIFACT_BYTES : 1);
        return {
          path: filePath,
          name: `entry-${index}.bin`,
          downloadCompression: null,
        };
      }),
    );
    expect(4 * MAX_BUNDLE_ARTIFACT_BYTES + 1).toBe(
      MAX_BUNDLE_EXPANDED_BYTES + 1,
    );

    await expect(getBundleZipTargets(buildPath, artifacts)).rejects.toThrow(
      `beyond ${MAX_BUNDLE_EXPANDED_BYTES} bytes`,
    );
  });

  it("rejects a file outside the declared build directory", async () => {
    const outside = path.join(directory, "build-other", "secret.bin");
    await fs.mkdir(path.dirname(outside));
    await fs.writeFile(outside, "outside");
    await expect(
      getBundleZipTargets(buildPath, [
        { path: outside, name: "secret.bin", downloadCompression: null },
      ]),
    ).rejects.toThrow("outside the build directory");
  });

  it("rejects a symbolic file and a symbolic ancestor", async () => {
    const actual = path.join(buildPath, "actual");
    await fs.mkdir(actual);
    await fs.writeFile(path.join(actual, "entry.bin"), "entry");
    const alias = path.join(buildPath, "alias");
    await fs.symlink(actual, alias, "dir");
    await expect(
      getBundleZipTargets(buildPath, [
        {
          path: path.join(alias, "entry.bin"),
          name: "entry.bin",
          downloadCompression: null,
        },
      ]),
    ).rejects.toThrow("symbolic links");

    const linkedFile = path.join(buildPath, "entry.bin");
    await fs.symlink(path.join(actual, "entry.bin"), linkedFile, "file");
    await expect(
      getBundleZipTargets(buildPath, [
        { path: linkedFile, name: "entry.bin", downloadCompression: null },
      ]),
    ).rejects.toThrow("regular file");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a socket without reading it",
    async () => {
      const socketPath = path.join(buildPath, "runtime.sock");
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        await expect(
          getBundleZipTargets(buildPath, [
            {
              path: socketPath,
              name: "runtime.sock",
              downloadCompression: null,
            },
          ]),
        ).rejects.toThrow("regular file");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
