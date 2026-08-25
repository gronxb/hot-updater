// @vitest-environment node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import type { Bundle } from "@hot-updater/plugin-core";
import { createStoragePlugin } from "@hot-updater/plugin-core";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigResponse } from "./loadConfig";
import {
  createCopiedBundleArchive,
  LEGACY_BUNDLE_ERROR,
} from "./promoteBundle";

const baseBundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  platform: "ios",
  fileHash: "abc123",
  storageUri: "https://example.com/bundle.zip",
  archiveByteSize: 3_000_000_001,
  gitCommitHash: "deadbeef",
};

const config = {
  signing: {
    enabled: false,
  },
} as ConfigResponse;

interface TestBundleManifest {
  assets: Record<
    string,
    {
      downloadByteSize?: number;
      downloadFileHash?: string;
      fileHash: string;
    }
  >;
  bundleId: string;
}

async function createZipArchive(
  archivePath: string,
  files: Record<string, string>,
) {
  const zip = new JSZip();

  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }

  await fs.writeFile(
    archivePath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

async function createTarGzArchive(
  archivePath: string,
  files: Record<string, string>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-tar-gz-"));

  try {
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }

    const entries = await fs.readdir(dir);
    entries.sort((left, right) => left.localeCompare(right));

    await tar.create(
      {
        file: archivePath,
        cwd: dir,
        gzip: true,
      },
      entries,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createTarBrArchive(
  archivePath: string,
  files: Record<string, string>,
) {
  const { brotliCompressSync } = await import("node:zlib");
  const tarPath = archivePath.replace(/\.br$/, "");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-tar-br-"));

  try {
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }

    const entries = await fs.readdir(dir);
    entries.sort((left, right) => left.localeCompare(right));

    await tar.create(
      {
        file: tarPath,
        cwd: dir,
        gzip: false,
      },
      entries,
    );

    await fs.writeFile(
      archivePath,
      brotliCompressSync(await fs.readFile(tarPath)),
    );
  } finally {
    await fs.rm(tarPath, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readZipManifest(archivePath: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
  const manifest = zip.file("manifest.json");
  if (!manifest) {
    throw new Error("manifest.json not found");
  }

  return JSON.parse(await manifest.async("text")) as TestBundleManifest;
}

async function readTarManifest(archivePath: string, gzip: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-read-tar-"));

  try {
    await tar.extract({
      file: archivePath,
      cwd: dir,
      gzip,
      strict: true,
    });

    return JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
    ) as TestBundleManifest;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readTarBrManifest(archivePath: string) {
  const { brotliDecompressSync } = await import("node:zlib");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-read-br-"));
  const tarPath = path.join(dir, "bundle.tar");

  try {
    await fs.writeFile(
      tarPath,
      brotliDecompressSync(await fs.readFile(archivePath)),
    );
    await tar.extract({
      file: tarPath,
      cwd: dir,
      gzip: false,
      strict: true,
    });

    return JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
    ) as TestBundleManifest;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createSourceArchive(
  format: "zip" | "tar.gz" | "tar.br",
  files: Record<string, string>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-source-"));
  const archivePath = path.join(dir, `bundle.${format}`);

  switch (format) {
    case "zip":
      await createZipArchive(archivePath, files);
      break;
    case "tar.gz":
      await createTarGzArchive(archivePath, files);
      break;
    case "tar.br":
      await createTarBrArchive(archivePath, files);
      break;
  }

  return {
    archivePath,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createCopiedBundleArchive", () => {
  it.each([
    ["zip", readZipManifest],
    ["tar.gz", (archivePath: string) => readTarManifest(archivePath, true)],
    ["tar.br", readTarBrManifest],
  ] as const)(
    "rewrites manifest.json and uploads a %s archive",
    async (format, readManifest) => {
      const { archivePath, cleanup } = await createSourceArchive(format, {
        "assets/logo.png": "logo",
        "index.js": "console.log('hello');",
        "manifest.json": JSON.stringify({
          bundleId: baseBundle.id,
          assets: {
            "assets/logo.png": {
              downloadByteSize: 999,
              downloadFileHash: "stale-transfer-hash",
              fileHash: "logo-hash",
            },
            "index.js": {
              fileHash: "asset-hash",
            },
          },
        }),
      });
      const uploadedFiles = new Map<string, string>();
      const storagePlugin = createStoragePlugin({
        name: "mockStorage",
        protocol: "s3",
        delete: vi.fn(async () => ({ deleted: true as const })),
        exists: vi.fn(async () => ({ exists: false })),
        get: vi.fn(async () => ({ response: null })),
        put: vi.fn(async ({ key, body }) => {
          const finalPath = path.join(
            path.dirname(archivePath),
            "uploads",
            key,
          );
          await fs.mkdir(path.dirname(finalPath), { recursive: true });
          await fs.writeFile(
            finalPath,
            new Uint8Array(await new Response(body).arrayBuffer()),
          );
          uploadedFiles.set(key, finalPath);
          return {
            storageUri: `s3://bucket/${path
              .relative(
                path.join(path.dirname(archivePath), "uploads"),
                finalPath,
              )
              .split(path.sep)
              .join("/")}`,
          };
        }),
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const response = new Response(await fs.readFile(archivePath));
          vi.spyOn(response, "arrayBuffer").mockRejectedValue(
            new Error("arrayBuffer must not be used"),
          );
          return response;
        }),
      );

      try {
        const { bundle: copiedBundle, uploadedStorageUris } =
          await createCopiedBundleArchive({
            bundle: {
              ...baseBundle,
              storageUri: `https://example.com/bundle.${format}`,
            },
            config,
            nextBundleId: "bundle-copy-id",
            storagePlugin,
          });

        expect(copiedBundle.id).toBe("bundle-copy-id");
        expect(copiedBundle.storageUri).toBe(
          `s3://bucket/bundles/bundle-copy-id/bundle.${format}`,
        );
        expect(copiedBundle.fileHash).not.toBe(baseBundle.fileHash);
        expect(copiedBundle).toMatchObject({
          assetBaseStorageUri: "s3://bucket/assets",
          manifestStorageUri:
            "s3://bucket/bundles/bundle-copy-id/manifest.json",
          patches: [],
        });
        expect(copiedBundle.manifestFileHash).toMatch(/^[a-f0-9]{64}$/);
        expect(copiedBundle.metadata ?? {}).not.toHaveProperty(
          "manifest_storage_uri",
        );
        expect(uploadedStorageUris).toEqual(
          expect.arrayContaining([
            `s3://bucket/bundles/bundle-copy-id/bundle.${format}`,
            "s3://bucket/bundles/bundle-copy-id/manifest.json",
          ]),
        );
        expect(uploadedStorageUris).toHaveLength(2);
        expect(uploadedFiles.has("assets/sha256/lo/logo-hash.png")).toBe(true);
        expect(uploadedFiles.has("assets/sha256/as/asset-hash.js")).toBe(true);

        const uploadedArchivePath = uploadedFiles.get(
          path.posix.join("bundles", "bundle-copy-id", `bundle.${format}`),
        );
        expect(uploadedArchivePath).toBeDefined();
        await expect(
          fs.stat(uploadedArchivePath as string),
        ).resolves.toMatchObject({ size: copiedBundle.archiveByteSize });

        const manifest = await readManifest(uploadedArchivePath as string);
        expect(manifest.bundleId).toBe("bundle-copy-id");
        const uploadedManifestPath = uploadedFiles.get(
          "bundles/bundle-copy-id/manifest.json",
        );
        expect(uploadedManifestPath).toBeDefined();
        const uploadedManifest = JSON.parse(
          await fs.readFile(uploadedManifestPath as string, "utf8"),
        ) as TestBundleManifest;
        expect(uploadedManifest).toMatchObject({
          assets: {
            "assets/logo.png": {
              downloadByteSize: Buffer.byteLength("logo"),
              fileHash: "logo-hash",
            },
            "index.js": {
              downloadByteSize: Buffer.byteLength("console.log('hello');"),
              fileHash: "asset-hash",
            },
          },
          bundleId: "bundle-copy-id",
        });
        expect(uploadedManifest.assets["assets/logo.png"]).not.toHaveProperty(
          "downloadFileHash",
        );
        expect(manifest).toEqual(uploadedManifest);
      } finally {
        await cleanup();
      }
    },
  );

  it("throws a legacy bundle error when manifest.json is missing", async () => {
    const { archivePath, cleanup } = await createSourceArchive("zip", {
      "index.js": "console.log('hello');",
    });
    const storagePlugin = createStoragePlugin({
      name: "mockStorage",
      protocol: "s3",
      delete: vi.fn(async () => ({ deleted: true as const })),
      exists: vi.fn(async () => ({ exists: false })),
      get: vi.fn(async () => ({ response: null })),
      put: vi.fn(async () => ({ storageUri: "s3://bucket/unreachable" })),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(await fs.readFile(archivePath));
      }),
    );

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: baseBundle,
          config,
          nextBundleId: "bundle-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow(LEGACY_BUNDLE_ERROR);
    } finally {
      await cleanup();
    }
  });

  it("uploads copied Hermes bundle assets with the brotli artifact name", async () => {
    const { archivePath, cleanup } = await createSourceArchive("zip", {
      "assets/logo.png": "logo",
      "index.ios.bundle": "hermes bytecode",
      "manifest.json": JSON.stringify({
        bundleId: baseBundle.id,
        assets: {
          "assets/logo.png": {
            fileHash: "logo-hash",
          },
          "index.ios.bundle": {
            downloadByteSize: 999,
            downloadFileHash: "c".repeat(64),
            fileHash: "bundle-hash",
          },
        },
      }),
    });
    const uploadedFiles = new Map<string, string>();
    const storagePlugin = createStoragePlugin({
      name: "mockStorage",
      protocol: "s3",
      delete: vi.fn(async () => ({ deleted: true as const })),
      exists: vi.fn(async () => ({ exists: false })),
      get: vi.fn(async () => ({ response: null })),
      put: vi.fn(async ({ key, body }) => {
        const finalPath = path.join(path.dirname(archivePath), "uploads", key);
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(
          finalPath,
          new Uint8Array(await new Response(body).arrayBuffer()),
        );
        uploadedFiles.set(key, finalPath);
        return {
          storageUri: `s3://bucket/${path
            .relative(
              path.join(path.dirname(archivePath), "uploads"),
              finalPath,
            )
            .split(path.sep)
            .join("/")}`,
        };
      }),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(await fs.readFile(archivePath));
      }),
    );

    try {
      const { bundle: copiedBundle, uploadedStorageUris } =
        await createCopiedBundleArchive({
          bundle: baseBundle,
          config,
          nextBundleId: "bundle-copy-id",
          storagePlugin,
        });

      expect(uploadedStorageUris).toEqual(
        expect.arrayContaining([
          "s3://bucket/bundles/bundle-copy-id/bundle.zip",
          "s3://bucket/bundles/bundle-copy-id/manifest.json",
        ]),
      );
      expect(uploadedStorageUris).not.toContain(
        "s3://bucket/assets/sha256/bu/bundle-hash.br",
      );

      const uploadedManifestPath = uploadedFiles.get(
        "bundles/bundle-copy-id/manifest.json",
      );
      expect(uploadedManifestPath).toBeDefined();
      const uploadedManifest = JSON.parse(
        await fs.readFile(uploadedManifestPath as string, "utf8"),
      ) as TestBundleManifest;
      const bundleAsset = uploadedManifest.assets["index.ios.bundle"]!;
      expect(bundleAsset.downloadFileHash).toMatch(/^[a-f0-9]{64}$/);

      const transferredFileHash = bundleAsset.downloadFileHash!;
      const transferredStorageKey = `assets/sha256/${transferredFileHash.slice(
        0,
        2,
      )}/${transferredFileHash}.br`;
      const uploadedBundlePath = uploadedFiles.get(transferredStorageKey);
      expect(uploadedBundlePath).toBeDefined();
      expect(uploadedFiles.has("assets/sha256/bu/bundle-hash.br")).toBe(false);
      const transferredBody = await fs.readFile(uploadedBundlePath as string);
      expect(brotliDecompressSync(transferredBody).toString("utf8")).toBe(
        "hermes bytecode",
      );
      expect(bundleAsset.downloadByteSize).toBe(transferredBody.byteLength);
      expect(
        crypto.createHash("sha256").update(transferredBody).digest("hex"),
      ).toBe(transferredFileHash);
      expect(storagePlugin.exists).toHaveBeenCalledWith({
        storageUri: `s3://bucket/${transferredStorageKey}`,
      });

      const uploadedArchivePath = uploadedFiles.get(
        "bundles/bundle-copy-id/bundle.zip",
      );
      expect(uploadedArchivePath).toBeDefined();
      expect((await fs.stat(uploadedArchivePath as string)).size).toBe(
        copiedBundle.archiveByteSize,
      );
      expect(await readZipManifest(uploadedArchivePath as string)).toEqual(
        uploadedManifest,
      );
    } finally {
      await cleanup();
    }
  });
});
