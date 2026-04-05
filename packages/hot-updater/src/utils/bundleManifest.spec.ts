import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/signedHashUtils", () => ({
  createSignedFileHash: vi.fn((value: string) => `sig:${value}`),
}));

vi.mock("./signing/bundleSigning", () => ({
  signBundle: vi.fn(async (fileHash: string) => `signature:${fileHash}`),
}));

import { createBundleManifest, writeBundleManifest } from "./bundleManifest";
import { signBundle } from "./signing/bundleSigning";

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
      targetFiles: [
        { path: assetPath, name: "assets/logo.png" },
        { path: bundlePath, name: "index.android.bundle" },
      ],
    });

    expect(manifest).toEqual({
      bundleId: "bundle-123",
      assets: {
        "assets/logo.png": {
          fileHash: hash("logo-content"),
        },
        "index.android.bundle": {
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
      targetFiles: [{ path: bundlePath, name: "index.android.bundle" }],
    });

    const writtenManifest = JSON.parse(
      await fs.readFile(manifestPath, "utf-8"),
    );

    expect(manifest).toEqual(writtenManifest);
    expect(writtenManifest).toEqual({
      bundleId: "bundle-456",
      assets: {
        "index.android.bundle": {
          fileHash: hash("bundle-content"),
        },
      },
    });
    expect(writtenManifest.assets).not.toHaveProperty("manifest.json");
  });

  it("stores signed asset hashes when a signing key is provided", async () => {
    const buildPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-manifest-"),
    );
    createdDirectories.push(buildPath);

    const bundlePath = path.join(buildPath, "index.android.bundle");
    await fs.writeFile(bundlePath, "bundle-content");

    const manifest = await createBundleManifest({
      bundleId: "bundle-789",
      signingPrivateKeyPath: "/mock/private.pem",
      targetFiles: [{ path: bundlePath, name: "index.android.bundle" }],
    });

    expect(signBundle).toHaveBeenCalledWith(
      hash("bundle-content"),
      "/mock/private.pem",
    );
    expect(manifest).toEqual({
      bundleId: "bundle-789",
      assets: {
        "index.android.bundle": {
          fileHash: `sig:signature:${hash("bundle-content")}`,
        },
      },
    });
  });
});
