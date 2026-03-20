import { createHash } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST_FILENAME,
  createBundleManifest,
  writeBundleManifestFile,
} from "./bundleManifest";

const tmpDirs: string[] = [];

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe("bundleManifest", () => {
  afterEach(async () => {
    await Promise.all(
      tmpDirs
        .splice(0)
        .map((tmpDir) => fs.rm(tmpDir, { recursive: true, force: true })),
    );
  });

  it("creates a manifest from bundle target files", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-manifest-"));
    tmpDirs.push(tmpDir);

    const nestedDir = path.join(tmpDir, "assets");
    await fs.mkdir(nestedDir, { recursive: true });

    const bundleFile = path.join(tmpDir, "index.android.bundle");
    const assetFile = path.join(nestedDir, "logo.png");

    await fs.writeFile(bundleFile, "console.log('bundle');");
    await fs.writeFile(assetFile, "binary-image-content");

    const manifest = await createBundleManifest("bundle-123", [
      {
        path: bundleFile,
        name: "index.android.bundle",
      },
      {
        path: assetFile,
        name: "assets/logo.png",
      },
    ]);

    expect(manifest).toEqual({
      bundleId: "bundle-123",
      files: {
        "assets/logo.png": sha256("binary-image-content"),
        "index.android.bundle": sha256("console.log('bundle');"),
      },
    });
  });

  it("writes manifest.json with pretty formatting", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-manifest-"));
    tmpDirs.push(tmpDir);

    const manifestPath = path.join(tmpDir, BUNDLE_MANIFEST_FILENAME);

    await writeBundleManifestFile(manifestPath, {
      bundleId: "bundle-123",
      files: {
        "index.ios.bundle": sha256("ios"),
      },
    });

    await expect(fs.readFile(manifestPath, "utf-8")).resolves.toBe(`{
  "bundleId": "bundle-123",
  "files": {
    "index.ios.bundle": "${sha256("ios")}"
  }
}
`);
  });
});
