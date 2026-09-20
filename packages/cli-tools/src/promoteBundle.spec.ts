// @vitest-environment node

import crypto from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import type { Bundle } from "@hot-updater/plugin-core";
import {
  createStoragePlugin,
  getManifestAssetStoragePath,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigResponse } from "./loadConfig";
import { createCopiedBundleArtifacts } from "./promoteBundle";

const sha256 = (bytes: string | Uint8Array) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

type ManifestAsset = {
  downloadByteSize?: number;
  downloadFileHash?: string;
  fileHash: string;
  signature?: string;
};

type Manifest = {
  assets: Record<string, ManifestAsset>;
  bundleId: string;
};

const encodeManifest = (manifest: Manifest) =>
  Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

const sourceBundle = (manifestBytes: Uint8Array): Bundle => ({
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  platform: "ios",
  gitCommitHash: "deadbeef",
  manifestStorageUri: "s3://bucket/source/manifest.json",
  manifestFileHash: sha256(manifestBytes),
  assetBaseStorageUri: "s3://bucket/assets",
});

const createStorageFixture = (sourceObjects: Map<string, Uint8Array>) => {
  const uploaded = new Map<string, Buffer>();
  const plugin = createStoragePlugin({
    name: "mock-storage",
    protocol: "s3",
    get: vi.fn(async ({ storageUri }) => ({
      response: sourceObjects.has(storageUri)
        ? new Response(sourceObjects.get(storageUri))
        : null,
    })),
    put: vi.fn(async ({ key, body }) => {
      uploaded.set(key, Buffer.from(await new Response(body).arrayBuffer()));
      return { storageUri: `s3://bucket/${key}` };
    }),
    exists: vi.fn(async ({ storageUri }) => ({
      exists: uploaded.has(new URL(storageUri).pathname.slice(1)),
    })),
    delete: vi.fn(async () => ({ deleted: true as const })),
  });
  return { plugin, uploaded };
};

const addSourceAsset = ({
  assetPath,
  body,
  manifest,
  sourceObjects,
}: {
  assetPath: string;
  body: Uint8Array;
  manifest: Manifest;
  sourceObjects: Map<string, Uint8Array>;
}) => {
  const asset = manifest.assets[assetPath]!;
  const storagePath = getManifestAssetStoragePath({
    assetPath: assetPath.endsWith(".bundle") ? `${assetPath}.br` : assetPath,
    downloadFileHash: asset.downloadFileHash,
    fileHash: asset.fileHash,
  });
  sourceObjects.set(`s3://bucket/assets/${storagePath}`, body);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCopiedBundleArtifacts", () => {
  it("copies manifest files without creating an archive", async () => {
    const logo = Buffer.from("logo");
    const hbc = Buffer.from("hermes bytecode");
    const compressedHbc = brotliCompressSync(hbc);
    const manifest: Manifest = {
      bundleId: "source",
      assets: {
        "assets/logo.png": {
          downloadByteSize: logo.byteLength,
          fileHash: sha256(logo),
        },
        "index.ios.bundle": {
          downloadByteSize: compressedHbc.byteLength,
          downloadFileHash: sha256(compressedHbc),
          fileHash: sha256(hbc),
        },
      },
    };
    const manifestBytes = encodeManifest(manifest);
    const sourceObjects = new Map<string, Uint8Array>([
      ["s3://bucket/source/manifest.json", manifestBytes],
    ]);
    addSourceAsset({
      assetPath: "assets/logo.png",
      body: logo,
      manifest,
      sourceObjects,
    });
    addSourceAsset({
      assetPath: "index.ios.bundle",
      body: compressedHbc,
      manifest,
      sourceObjects,
    });
    const { plugin, uploaded } = createStorageFixture(sourceObjects);

    const result = await createCopiedBundleArtifacts({
      bundle: sourceBundle(manifestBytes),
      config: {} as ConfigResponse,
      nextBundleId: "copy",
      storagePlugin: plugin,
    });

    expect(result.bundle).toMatchObject({
      id: "copy",
      manifestStorageUri: "s3://bucket/bundles/copy/manifest.json",
      assetBaseStorageUri: "s3://bucket/assets",
      patches: [],
    });
    expect(result.uploadedStorageUris).toEqual([
      "s3://bucket/bundles/copy/manifest.json",
    ]);
    expect([...uploaded.keys()]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/bundle\.(zip|tar)/)]),
    );

    const copiedManifest = JSON.parse(
      uploaded.get("bundles/copy/manifest.json")!.toString("utf8"),
    ) as Manifest;
    expect(copiedManifest.bundleId).toBe("copy");
    const copiedHbc = copiedManifest.assets["index.ios.bundle"]!;
    const copiedTransfer = uploaded.get(
      `assets/${getManifestAssetStoragePath({
        assetPath: "index.ios.bundle.br",
        downloadFileHash: copiedHbc.downloadFileHash,
        fileHash: copiedHbc.fileHash,
      })}`,
    );
    expect(copiedTransfer).toBeDefined();
    expect(brotliDecompressSync(copiedTransfer!)).toEqual(hbc);
  });

  it("re-signs manifest and assets with bounded provider concurrency", async () => {
    const keys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const manifest: Manifest = { bundleId: "source", assets: {} };
    const sourceObjects = new Map<string, Uint8Array>();
    for (let index = 0; index < 12; index += 1) {
      const assetPath = `assets/${index}.txt`;
      const body = Buffer.from(`asset-${index}`);
      manifest.assets[assetPath] = { fileHash: sha256(body) };
      addSourceAsset({ assetPath, body, manifest, sourceObjects });
    }
    const manifestBytes = encodeManifest(manifest);
    sourceObjects.set("s3://bucket/source/manifest.json", manifestBytes);
    let active = 0;
    let maxActive = 0;
    const sign = vi.fn(async ({ message }: { message: Uint8Array }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return {
          signature: crypto.sign("RSA-SHA256", message, keys.privateKey),
        };
      } finally {
        active -= 1;
      }
    });
    const config = {
      signing: {
        name: "test-signer",
        getPublicKey: async () => ({ publicKey: keys.publicKey }),
        sign,
      },
    } as unknown as ConfigResponse;
    const source = sourceBundle(manifestBytes);
    source.manifestFileHash = `sig:${crypto
      .sign(
        "RSA-SHA256",
        Buffer.from(sha256(manifestBytes), "hex"),
        keys.privateKey,
      )
      .toString("base64")}`;
    const { plugin, uploaded } = createStorageFixture(sourceObjects);

    const { bundle } = await createCopiedBundleArtifacts({
      bundle: source,
      config,
      nextBundleId: "signed-copy",
      storagePlugin: plugin,
    });

    const copiedManifestBytes = uploaded.get(
      "bundles/signed-copy/manifest.json",
    )!;
    const copiedManifest = JSON.parse(
      copiedManifestBytes.toString("utf8"),
    ) as Manifest;
    expect(
      Object.values(copiedManifest.assets).every((asset) => asset.signature),
    ).toBe(true);
    expect(
      crypto.verify(
        "RSA-SHA256",
        Buffer.from(sha256(copiedManifestBytes), "hex"),
        keys.publicKey,
        Buffer.from(bundle.manifestFileHash.slice(4), "base64"),
      ),
    ).toBe(true);
    expect(sign).toHaveBeenCalledTimes(13);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(8);
  });

  it("rejects a manifest whose signed bytes were replaced", async () => {
    const keys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const original = encodeManifest({ bundleId: "source", assets: {} });
    const replacement = encodeManifest({ bundleId: "tampered", assets: {} });
    const source = sourceBundle(original);
    source.manifestFileHash = `sig:${crypto
      .sign("RSA-SHA256", Buffer.from(sha256(original), "hex"), keys.privateKey)
      .toString("base64")}`;
    const { plugin } = createStorageFixture(
      new Map([["s3://bucket/source/manifest.json", replacement]]),
    );

    await expect(
      createCopiedBundleArtifacts({
        bundle: source,
        config: {
          signing: {
            name: "test-signer",
            getPublicKey: async () => ({ publicKey: keys.publicKey }),
            sign: vi.fn(),
          },
        } as unknown as ConfigResponse,
        nextBundleId: "copy",
        storagePlugin: plugin,
      }),
    ).rejects.toThrow("Source manifest signature verification failed.");
    expect(plugin.put).not.toHaveBeenCalled();
  });

  it("rejects source bytes that do not match the manifest", async () => {
    const expected = Buffer.from("expected");
    const manifest: Manifest = {
      bundleId: "source",
      assets: { "index.js": { fileHash: sha256(expected) } },
    };
    const manifestBytes = encodeManifest(manifest);
    const sourceObjects = new Map<string, Uint8Array>([
      ["s3://bucket/source/manifest.json", manifestBytes],
    ]);
    addSourceAsset({
      assetPath: "index.js",
      body: Buffer.from("tampered"),
      manifest,
      sourceObjects,
    });
    const { plugin } = createStorageFixture(sourceObjects);

    await expect(
      createCopiedBundleArtifacts({
        bundle: sourceBundle(manifestBytes),
        config: {} as ConfigResponse,
        nextBundleId: "copy",
        storagePlugin: plugin,
      }),
    ).rejects.toThrow("Manifest file hash mismatch for index.js");
    expect(plugin.put).not.toHaveBeenCalled();
  });
});
