import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { MAX_BUNDLE_MANIFEST_BYTES } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBundleManifest,
  writeBundleManifest,
  writeBundleManifestFile,
} from "./bundleManifest";

const createdDirectories: string[] = [];

const hash = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

describe("bundleManifest", () => {
  afterEach(async () => {
    await Promise.all(
      createdDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    createdDirectories.length = 0;
  });

  it("creates asset hashes using archive-relative names", async () => {
    const buildPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-manifest-"),
    );
    createdDirectories.push(buildPath);

    const bundlePath = path.join(buildPath, "index.android.bundle");
    const assetDirectory = path.join(buildPath, "assets");
    const assetPath = path.join(assetDirectory, "logo.png");

    await fs.mkdir(assetDirectory, { recursive: true });
    await fs.writeFile(bundlePath, "bundle-content");
    await fs.writeFile(assetPath, "logo-content");

    const manifest = await createBundleManifest({
      bundleId: "bundle-123",
      patchAssetPath: "runtime/main.opaque",
      targetFiles: [
        {
          path: assetPath,
          name: "assets/logo.png",
          downloadCompression: null,
        },
        {
          path: bundlePath,
          name: "runtime/main.opaque",
          downloadCompression: "br",
        },
      ],
    });

    expect(manifest).toEqual({
      bundleId: "bundle-123",
      patchAssetPath: "runtime/main.opaque",
      assets: {
        "assets/logo.png": {
          downloadCompression: null,
          fileHash: hash("logo-content"),
        },
        "runtime/main.opaque": {
          downloadCompression: "br",
          fileHash: hash("bundle-content"),
        },
      },
    });
  });

  it("writes manifest.json without including itself in the assets list", async () => {
    const buildPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-manifest-"),
    );
    createdDirectories.push(buildPath);

    const bundlePath = path.join(buildPath, "index.android.bundle");
    await fs.writeFile(bundlePath, "bundle-content");

    const { manifest, manifestPath } = await writeBundleManifest({
      buildPath,
      bundleId: "bundle-456",
      patchAssetPath: "index.android.bundle",
      targetFiles: [
        {
          path: bundlePath,
          name: "index.android.bundle",
          downloadCompression: "br",
        },
      ],
    });

    const writtenManifest = JSON.parse(
      await fs.readFile(manifestPath, "utf-8"),
    );

    expect(manifest).toEqual(writtenManifest);
    expect(writtenManifest).toEqual({
      bundleId: "bundle-456",
      patchAssetPath: "index.android.bundle",
      assets: {
        "index.android.bundle": {
          downloadCompression: "br",
          fileHash: hash("bundle-content"),
        },
      },
    });
    expect(writtenManifest.assets).not.toHaveProperty("manifest.json");
  });

  it("writes asset signatures next to file hashes when signing is provided", async () => {
    const buildPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-manifest-"),
    );
    createdDirectories.push(buildPath);

    const bundlePath = path.join(buildPath, "index.ios.bundle");
    await fs.writeFile(bundlePath, "bundle-content");

    const signFileHash = async (fileHash: string) => `signed:${fileHash}`;
    const { manifest, manifestPath } = await writeBundleManifest({
      buildPath,
      bundleId: "bundle-signed",
      patchAssetPath: "index.ios.bundle",
      signFileHash,
      targetFiles: [
        {
          path: bundlePath,
          name: "index.ios.bundle",
          downloadCompression: "br",
        },
      ],
    });

    const expectedHash = hash("bundle-content");
    const writtenManifest = JSON.parse(
      await fs.readFile(manifestPath, "utf-8"),
    );

    expect(manifest).toEqual(writtenManifest);
    expect(writtenManifest.assets["index.ios.bundle"]).toEqual({
      downloadCompression: "br",
      fileHash: expectedHash,
      signature: `signed:${expectedHash}`,
    });
  });

  it("writes transferred payload identity and size into the final manifest", async () => {
    const buildPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-manifest-"),
    );
    createdDirectories.push(buildPath);
    const downloadFileHash = "b".repeat(64);
    const manifest = {
      bundleId: "bundle-sized",
      patchAssetPath: "index.ios.bundle",
      assets: {
        "index.ios.bundle": {
          downloadCompression: "br" as const,
          downloadByteSize: 123,
          downloadFileHash,
          fileHash: "a".repeat(64),
        },
      },
    };

    const manifestPath = await writeBundleManifestFile({
      buildPath,
      manifest,
    });

    expect(await fs.readFile(manifestPath, "utf8")).toBe(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  });

  it("uses locale-independent Unicode ordering for manifest assets", async () => {
    const buildPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-manifest-"),
    );
    createdDirectories.push(buildPath);
    const upper = path.join(buildPath, "upper");
    const nonAscii = path.join(buildPath, "non-ascii");
    await Promise.all([
      fs.writeFile(upper, "upper"),
      fs.writeFile(nonAscii, "non-ascii"),
    ]);

    const manifest = await createBundleManifest({
      bundleId: "bundle-order",
      patchAssetPath: "Z.asset",
      targetFiles: [
        { path: nonAscii, name: "ä.asset", downloadCompression: null },
        { path: upper, name: "Z.asset", downloadCompression: null },
      ],
    });

    expect(Object.keys(manifest.assets)).toEqual(["Z.asset", "ä.asset"]);
  });

  it("rejects generated manifest metadata above the native limit", async () => {
    const buildPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-manifest-"),
    );
    createdDirectories.push(buildPath);
    const manifest = {
      bundleId: "bundle-oversized",
      patchAssetPath: "entry.bin",
      assets: {
        "entry.bin": {
          downloadCompression: null,
          fileHash: "a".repeat(64),
          signature: "s".repeat(MAX_BUNDLE_MANIFEST_BYTES),
        },
      },
    };

    await expect(
      writeBundleManifestFile({ buildPath, manifest }),
    ).rejects.toThrow(`exceeds ${MAX_BUNDLE_MANIFEST_BYTES} bytes`);
    await expect(
      fs.stat(path.join(buildPath, "manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("limits concurrent file hash and signing work", async () => {
    const buildPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-manifest-"),
    );
    createdDirectories.push(buildPath);

    const targetFiles = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const filePath = path.join(buildPath, `asset-${index}.txt`);
        await fs.writeFile(filePath, `asset-${index}`);
        return {
          path: filePath,
          name: `asset-${index}.txt`,
          downloadCompression: null,
        };
      }),
    );

    let active = 0;
    let maxActive = 0;
    const signFileHash = async (fileHash: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return `signed:${fileHash}`;
    };

    await createBundleManifest({
      bundleId: "bundle-concurrency",
      hashConcurrency: 2,
      patchAssetPath: "asset-0.txt",
      signFileHash,
      targetFiles,
    });

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
