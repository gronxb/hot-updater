// @vitest-environment node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

import type { Bundle } from "@hot-updater/plugin-core";
import {
  createStoragePlugin,
  MAX_BUNDLE_ARCHIVE_BYTES,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
} from "@hot-updater/plugin-core";
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

const config = {} as ConfigResponse;

interface TestBundleManifest {
  assets: Record<
    string,
    {
      downloadByteSize?: number;
      downloadCompression?: "br" | null;
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
    fileHash: crypto
      .createHash("sha256")
      .update(await fs.readFile(archivePath))
      .digest("hex"),
  };
}

function patchZipDeclaredUncompressedSize(
  archive: Buffer,
  entryName: string,
  byteSize: number,
) {
  const patched = Buffer.from(archive);
  let patchedHeaders = 0;

  for (let offset = 0; offset <= patched.length - 4; offset += 1) {
    const signature = patched.readUInt32LE(offset);
    const isLocalHeader = signature === 0x04034b50;
    const isCentralHeader = signature === 0x02014b50;
    if (!isLocalHeader && !isCentralHeader) {
      continue;
    }
    const nameLengthOffset = offset + (isLocalHeader ? 26 : 28);
    const nameOffset = offset + (isLocalHeader ? 30 : 46);
    const nameLength = patched.readUInt16LE(nameLengthOffset);
    if (
      patched.subarray(nameOffset, nameOffset + nameLength).toString("utf8") !==
      entryName
    ) {
      continue;
    }
    patched.writeUInt32LE(byteSize, offset + (isLocalHeader ? 22 : 24));
    patchedHeaders += 1;
  }

  if (patchedHeaders !== 2) {
    throw new Error(`Could not patch ZIP entry headers for ${entryName}`);
  }
  return patched;
}

const createGuardedStorage = (sourceResponse: Response | null = null) => {
  const put = vi.fn(async () => ({ storageUri: "s3://bucket/unreachable" }));
  const storagePlugin = createStoragePlugin({
    name: "guardedStorage",
    protocol: "s3",
    delete: vi.fn(async () => ({ deleted: true as const })),
    exists: vi.fn(async () => ({ exists: false })),
    get: vi.fn(async () => ({ response: sourceResponse })),
    put,
  });
  return { put, storagePlugin };
};

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
      const logoFileHash = crypto
        .createHash("sha256")
        .update("logo")
        .digest("hex");
      const indexFileHash = crypto
        .createHash("sha256")
        .update("console.log('hello');")
        .digest("hex");
      const {
        archivePath,
        cleanup,
        fileHash: sourceFileHash,
      } = await createSourceArchive(format, {
        "assets/logo.png": "logo",
        "index.js": "console.log('hello');",
        "manifest.json": JSON.stringify({
          bundleId: baseBundle.id,
          assets: {
            "assets/logo.png": {
              downloadByteSize: 999,
              downloadCompression: null,
              downloadFileHash: "stale-transfer-hash",
              fileHash: logoFileHash,
            },
            "index.js": {
              downloadCompression: null,
              fileHash: indexFileHash,
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
              fileHash: sourceFileHash,
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
        expect(
          uploadedFiles.has(
            `assets/sha256/${logoFileHash.slice(0, 2)}/${logoFileHash}.png`,
          ),
        ).toBe(true);
        expect(
          uploadedFiles.has(
            `assets/sha256/${indexFileHash.slice(0, 2)}/${indexFileHash}.js`,
          ),
        ).toBe(true);

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
        const manifestContentHash = crypto
          .createHash("sha256")
          .update(await fs.readFile(uploadedManifestPath as string))
          .digest("hex");
        expect(copiedBundle.manifestFileHash).toBe(manifestContentHash);
        expect(copiedBundle.metadata?.manifest_content_hash).toBe(
          manifestContentHash,
        );
        const uploadedManifest = JSON.parse(
          await fs.readFile(uploadedManifestPath as string, "utf8"),
        ) as TestBundleManifest;
        expect(uploadedManifest).toMatchObject({
          assets: {
            "assets/logo.png": {
              downloadByteSize: Buffer.byteLength("logo"),
              downloadCompression: null,
              fileHash: logoFileHash,
            },
            "index.js": {
              downloadByteSize: Buffer.byteLength("console.log('hello');"),
              downloadCompression: null,
              fileHash: indexFileHash,
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

  it("re-signs copied assets with bounded provider concurrency", async () => {
    const oldKeys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const nextKeys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const sourceAssets = Array.from({ length: 12 }, (_, index) => {
      const assetPath = `assets/asset-${index}.txt`;
      const content = `signed asset ${index}`;
      const fileHash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");
      const signature = crypto
        .sign("RSA-SHA256", Buffer.from(fileHash, "hex"), oldKeys.privateKey)
        .toString("base64");
      return { assetPath, content, fileHash, signature };
    });
    const firstAsset = sourceAssets[0]!;
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
      ...Object.fromEntries(
        sourceAssets.map(({ assetPath, content }) => [assetPath, content]),
      ),
      "manifest.json": JSON.stringify({
        bundleId: baseBundle.id,
        assets: Object.fromEntries(
          sourceAssets.map(({ assetPath, fileHash, signature }) => [
            assetPath,
            { downloadCompression: null, fileHash, signature },
          ]),
        ),
      }),
    });
    const signedSourceFileHash = `sig:${crypto
      .sign(
        "RSA-SHA256",
        Buffer.from(sourceFileHash, "hex"),
        nextKeys.privateKey,
      )
      .toString("base64")}`;
    let activeSignCalls = 0;
    let maxActiveSignCalls = 0;
    const providerSign = vi.fn(async ({ message }: { message: Uint8Array }) => {
      activeSignCalls += 1;
      maxActiveSignCalls = Math.max(maxActiveSignCalls, activeSignCalls);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return {
          signature: crypto.sign("RSA-SHA256", message, nextKeys.privateKey),
        };
      } finally {
        activeSignCalls -= 1;
      }
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
        return { storageUri: `s3://bucket/${key}` };
      }),
    });
    const signedConfig = {
      ...config,
      signing: {
        name: "test-provider",
        getPublicKey: async () => ({ publicKey: nextKeys.publicKey }),
        sign: providerSign,
      },
    } satisfies ConfigResponse;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );

    try {
      const { bundle } = await createCopiedBundleArchive({
        bundle: { ...baseBundle, fileHash: signedSourceFileHash },
        config: signedConfig,
        nextBundleId: "signed-copy-id",
        storagePlugin,
      });
      const uploadedManifestPath = uploadedFiles.get(
        "bundles/signed-copy-id/manifest.json",
      );
      const uploadedArchivePath = uploadedFiles.get(
        "bundles/signed-copy-id/bundle.zip",
      );
      expect(uploadedManifestPath).toBeDefined();
      expect(uploadedArchivePath).toBeDefined();
      const manifest = JSON.parse(
        await fs.readFile(uploadedManifestPath as string, "utf8"),
      ) as {
        assets?: Record<string, { fileHash: string; signature?: string }>;
      };
      const copiedAssetSignature =
        manifest.assets?.[firstAsset.assetPath]?.signature;

      expect(copiedAssetSignature).toBeDefined();
      expect(copiedAssetSignature).not.toBe(firstAsset.signature);
      expect(
        crypto.verify(
          "RSA-SHA256",
          Buffer.from(firstAsset.fileHash, "hex"),
          nextKeys.publicKey,
          Buffer.from(copiedAssetSignature as string, "base64"),
        ),
      ).toBe(true);

      const verifySignedHash = async (signedHash: string, filePath: string) => {
        const fileHash = crypto
          .createHash("sha256")
          .update(await fs.readFile(filePath))
          .digest();
        return crypto.verify(
          "RSA-SHA256",
          fileHash,
          nextKeys.publicKey,
          Buffer.from(signedHash.slice("sig:".length), "base64"),
        );
      };
      await expect(
        verifySignedHash(bundle.fileHash, uploadedArchivePath as string),
      ).resolves.toBe(true);
      await expect(
        verifySignedHash(
          bundle.manifestFileHash as string,
          uploadedManifestPath as string,
        ),
      ).resolves.toBe(true);
      expect(bundle.manifestFileHash).toMatch(/^sig:/);
      expect(bundle.metadata?.manifest_content_hash).toBe(
        crypto
          .createHash("sha256")
          .update(await fs.readFile(uploadedManifestPath as string))
          .digest("hex"),
      );
      expect(providerSign).toHaveBeenCalledTimes(sourceAssets.length + 2);
      expect(maxActiveSignCalls).toBeGreaterThan(1);
      expect(maxActiveSignCalls).toBeLessThanOrEqual(8);
    } finally {
      await cleanup();
    }
  });

  it("rejects a signed self-consistent replacement before signing or upload", async () => {
    const originalContent = "reviewed source";
    const originalFileHash = crypto
      .createHash("sha256")
      .update(originalContent)
      .digest("hex");
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
      "index.js": originalContent,
      "manifest.json": JSON.stringify({
        bundleId: baseBundle.id,
        assets: { "index.js": { fileHash: originalFileHash } },
      }),
    });
    const replacementContent = "unreviewed replacement";
    const replacementFileHash = crypto
      .createHash("sha256")
      .update(replacementContent)
      .digest("hex");
    await createZipArchive(archivePath, {
      "index.js": replacementContent,
      "manifest.json": JSON.stringify({
        bundleId: baseBundle.id,
        assets: { "index.js": { fileHash: replacementFileHash } },
      }),
    });

    const keys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const signedSourceFileHash = `sig:${crypto
      .sign("RSA-SHA256", Buffer.from(sourceFileHash, "hex"), keys.privateKey)
      .toString("base64")}`;
    const sign = vi.fn(async ({ message }: { message: Uint8Array }) => ({
      signature: crypto.sign("RSA-SHA256", message, keys.privateKey),
    }));
    const storagePlugin = createStoragePlugin({
      name: "mockStorage",
      protocol: "s3",
      delete: vi.fn(async () => ({ deleted: true as const })),
      exists: vi.fn(async () => ({ exists: false })),
      get: vi.fn(async () => ({ response: null })),
      put: vi.fn(async () => ({ storageUri: "s3://bucket/unreachable" })),
    });
    const signedConfig = {
      ...config,
      signing: {
        name: "test-provider",
        getPublicKey: async () => ({ publicKey: keys.publicKey }),
        sign,
      },
    } satisfies ConfigResponse;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: { ...baseBundle, fileHash: signedSourceFileHash },
          config: signedConfig,
          nextBundleId: "bundle-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow("Source bundle signature verification failed.");
      expect(sign).not.toHaveBeenCalled();
      expect(storagePlugin.put).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("rejects signed manifest assets before uploading without a signer", async () => {
    const assetFileHash = "ab".repeat(32);
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
      "index.js": "signed asset",
      "manifest.json": JSON.stringify({
        bundleId: baseBundle.id,
        assets: {
          "index.js": {
            fileHash: assetFileHash,
            signature: "existing-signature",
          },
        },
      }),
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
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: { ...baseBundle, fileHash: sourceFileHash },
          config,
          nextBundleId: "bundle-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow(
        "Cannot copy a signed bundle without enabled bundle signing configuration.",
      );
      expect(storagePlugin.put).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("rejects an unsigned copied asset whose bytes do not match the manifest", async () => {
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
      "index.js": "tampered asset bytes",
      "manifest.json": JSON.stringify({
        bundleId: baseBundle.id,
        assets: {
          "index.js": { fileHash: "ab".repeat(32) },
        },
      }),
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
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: { ...baseBundle, fileHash: sourceFileHash },
          config,
          nextBundleId: "bundle-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow("Manifest file hash mismatch for index.js");
      expect(storagePlugin.put).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("preserves a shared asset when a concurrent copy publishes it before rollback", async () => {
    const assetContent = "copy asset";
    const assetFileHash = crypto
      .createHash("sha256")
      .update(assetContent)
      .digest("hex");
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
      "runtime/entry.bin": assetContent,
      "manifest.json": JSON.stringify({
        assets: {
          "runtime/entry.bin": {
            downloadCompression: null,
            fileHash: assetFileHash,
          },
        },
        bundleId: baseBundle.id,
      }),
    });
    const assetStorageUri = `s3://bucket/assets/sha256/${assetFileHash.slice(
      0,
      2,
    )}/${assetFileHash}.bin`;
    const sharedObjects = new Set<string>();
    const deletedStorageUris: string[] = [];
    const put = vi.fn(async ({ key }: { key: string }) => {
      if (key === "bundles/copy-cleanup-id/manifest.json") {
        throw new Error("manifest upload failed");
      }
      const storageUri = `s3://bucket/${key}`;
      if (storageUri === assetStorageUri) {
        // A concurrent promotion may publish the same content-addressed object
        // after both callers observe exists:false.
        sharedObjects.add(storageUri);
      }
      return { storageUri };
    });
    const storagePlugin = createStoragePlugin({
      name: "cleanupStorage",
      protocol: "s3",
      delete: vi.fn(async ({ storageUri }) => {
        deletedStorageUris.push(storageUri);
        sharedObjects.delete(storageUri);
        return { deleted: true as const };
      }),
      exists: vi.fn(async () => ({ exists: false })),
      get: vi.fn(async () => ({ response: null })),
      put,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: { ...baseBundle, fileHash: sourceFileHash },
          config,
          nextBundleId: "copy-cleanup-id",
          storagePlugin,
        }),
      ).rejects.toThrow("manifest upload failed");

      expect(deletedStorageUris).toEqual([
        "s3://bucket/bundles/copy-cleanup-id/bundle.zip",
      ]);
      expect(sharedObjects).toContain(assetStorageUri);
    } finally {
      await cleanup();
    }
  });

  it("throws a legacy bundle error when manifest.json is missing", async () => {
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
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
          bundle: { ...baseBundle, fileHash: sourceFileHash },
          config,
          nextBundleId: "bundle-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow(LEGACY_BUNDLE_ERROR);
    } finally {
      await cleanup();
    }
  });

  it.each(["http", "storage"] as const)(
    "rejects an oversized %s source response before writing or publishing",
    async (source) => {
      const response = new Response("small body", {
        headers: {
          "content-length": String(MAX_BUNDLE_ARCHIVE_BYTES + 1),
        },
      });
      const { put, storagePlugin } = createGuardedStorage(
        source === "storage" ? response : null,
      );
      if (source === "http") {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => response),
        );
      }

      await expect(
        createCopiedBundleArchive({
          bundle: {
            ...baseBundle,
            storageUri:
              source === "http"
                ? "https://example.com/oversized.zip"
                : "s3://bucket/oversized.zip",
          },
          config,
          nextBundleId: "oversized-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow(
        `Bundle archive exceeds ${MAX_BUNDLE_ARCHIVE_BYTES} bytes`,
      );
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("rejects a ZIP entry bomb from its declared size before decompression", async () => {
    const { archivePath, cleanup } = await createSourceArchive("zip", {
      "bomb.bin": "small compressed body",
      "manifest.json": JSON.stringify({
        assets: {
          "bomb.bin": {
            downloadCompression: null,
            fileHash: "ab".repeat(32),
          },
        },
        bundleId: baseBundle.id,
      }),
    });
    const patchedArchive = patchZipDeclaredUncompressedSize(
      await fs.readFile(archivePath),
      "bomb.bin",
      MAX_BUNDLE_ARTIFACT_BYTES + 1,
    );
    await fs.writeFile(archivePath, patchedArchive);
    const fileHash = crypto
      .createHash("sha256")
      .update(patchedArchive)
      .digest("hex");
    const { put, storagePlugin } = createGuardedStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: { ...baseBundle, fileHash },
          config,
          nextBundleId: "zip-bomb-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow(
        `Build artifact exceeds ${MAX_BUNDLE_ARTIFACT_BYTES} bytes: bomb.bin`,
      );
      expect(put).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("rejects an oversized manifest before parsing or publishing", async () => {
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
      "manifest.json": JSON.stringify({
        assets: {},
        bundleId: baseBundle.id,
        padding: "x".repeat(MAX_BUNDLE_MANIFEST_BYTES),
      }),
    });
    const { put, storagePlugin } = createGuardedStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: { ...baseBundle, fileHash: sourceFileHash },
          config,
          nextBundleId: "oversized-manifest-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow(
        `Bundle manifest exceeds ${MAX_BUNDLE_MANIFEST_BYTES} bytes`,
      );
      expect(put).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("rejects a TAR symlink without reading its external target or publishing", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "promote-tar-symlink-"),
    );
    const sourceDir = path.join(directory, "source");
    const secretPath = path.join(directory, "external-secret.txt");
    const archivePath = path.join(directory, "bundle.tar.gz");
    await fs.mkdir(sourceDir);
    await fs.writeFile(secretPath, "must not be read");
    await fs.symlink(secretPath, path.join(sourceDir, "manifest.json"));
    await tar.create(
      {
        cwd: sourceDir,
        file: archivePath,
        gzip: true,
      },
      ["manifest.json"],
    );
    const sourceFileHash = crypto
      .createHash("sha256")
      .update(await fs.readFile(archivePath))
      .digest("hex");
    const { put, storagePlugin } = createGuardedStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );
    const readFile = vi.spyOn(fs, "readFile");

    try {
      await expect(
        createCopiedBundleArchive({
          bundle: {
            ...baseBundle,
            fileHash: sourceFileHash,
            storageUri: "https://example.com/bundle.tar.gz",
          },
          config,
          nextBundleId: "symlink-copy-id",
          storagePlugin,
        }),
      ).rejects.toThrow("Unsupported TAR entry type: SymbolicLink");
      expect(readFile).not.toHaveBeenCalledWith(secretPath);
      expect(put).not.toHaveBeenCalled();
      await expect(fs.readFile(secretPath, "utf8")).resolves.toBe(
        "must not be read",
      );
    } finally {
      readFile.mockRestore();
      await fs.rm(directory, { force: true, recursive: true });
    }
  });

  it("uploads an explicitly brotli-compressed engine-neutral asset", async () => {
    const logoFileHash = crypto
      .createHash("sha256")
      .update("logo")
      .digest("hex");
    const bundleFileHash = crypto
      .createHash("sha256")
      .update("lynx bytecode")
      .digest("hex");
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
      "assets/logo.png": "logo",
      "runtime/entry.lynxbc": "lynx bytecode",
      "manifest.json": JSON.stringify({
        bundleId: baseBundle.id,
        assets: {
          "assets/logo.png": {
            downloadCompression: null,
            fileHash: logoFileHash,
          },
          "runtime/entry.lynxbc": {
            downloadByteSize: 999,
            downloadCompression: "br",
            downloadFileHash: "c".repeat(64),
            fileHash: bundleFileHash,
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
          bundle: { ...baseBundle, fileHash: sourceFileHash },
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
        `s3://bucket/assets/sha256/${bundleFileHash.slice(0, 2)}/${bundleFileHash}.br`,
      );

      const uploadedManifestPath = uploadedFiles.get(
        "bundles/bundle-copy-id/manifest.json",
      );
      expect(uploadedManifestPath).toBeDefined();
      const uploadedManifest = JSON.parse(
        await fs.readFile(uploadedManifestPath as string, "utf8"),
      ) as TestBundleManifest;
      const bundleAsset = uploadedManifest.assets["runtime/entry.lynxbc"]!;
      expect(bundleAsset.downloadFileHash).toMatch(/^[a-f0-9]{64}$/);

      const transferredFileHash = bundleAsset.downloadFileHash!;
      const transferredStorageKey = `assets/sha256/${transferredFileHash.slice(
        0,
        2,
      )}/${transferredFileHash}.br`;
      const uploadedBundlePath = uploadedFiles.get(transferredStorageKey);
      expect(uploadedBundlePath).toBeDefined();
      expect(
        uploadedFiles.has(
          `assets/sha256/${bundleFileHash.slice(0, 2)}/${bundleFileHash}.br`,
        ),
      ).toBe(false);
      const transferredBody = await fs.readFile(uploadedBundlePath as string);
      expect(brotliDecompressSync(transferredBody).toString("utf8")).toBe(
        "lynx bytecode",
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

  it("keeps a legacy manifest archive-only without inferring compression from filenames", async () => {
    const bundleFileHash = crypto
      .createHash("sha256")
      .update("legacy hermes bytecode")
      .digest("hex");
    const {
      archivePath,
      cleanup,
      fileHash: sourceFileHash,
    } = await createSourceArchive("zip", {
      "index.ios.bundle": "legacy hermes bytecode",
      "manifest.json": JSON.stringify({
        bundleId: baseBundle.id,
        assets: {
          "index.ios.bundle": {
            downloadByteSize: 999,
            downloadFileHash: "c".repeat(64),
            fileHash: bundleFileHash,
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
        return { storageUri: `s3://bucket/${key}` };
      }),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await fs.readFile(archivePath))),
    );

    try {
      const { bundle } = await createCopiedBundleArchive({
        bundle: { ...baseBundle, fileHash: sourceFileHash },
        config,
        nextBundleId: "legacy-copy-id",
        storagePlugin,
      });

      expect(bundle.storageUri).toBe(
        "s3://bucket/bundles/legacy-copy-id/bundle.zip",
      );
      expect(storagePlugin.exists).not.toHaveBeenCalled();
      expect([...uploadedFiles.keys()].sort()).toEqual([
        "bundles/legacy-copy-id/bundle.zip",
        "bundles/legacy-copy-id/manifest.json",
      ]);

      const copiedManifest = JSON.parse(
        await fs.readFile(
          uploadedFiles.get("bundles/legacy-copy-id/manifest.json")!,
          "utf8",
        ),
      ) as TestBundleManifest;
      expect(copiedManifest.assets["index.ios.bundle"]).not.toHaveProperty(
        "downloadCompression",
      );
    } finally {
      await cleanup();
    }
  });
});
