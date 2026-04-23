import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hdiff } from "@hot-updater/bsdiff";
import {
  getAssetBaseStorageUri,
  getManifestStorageUri,
  getPatchStorageUri,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabasePlugin,
  StoragePlugin,
} from "@hot-updater/plugin-core";

type BundleManifest = {
  bundleId: string;
  assets: Record<string, { fileHash: string; signature?: string }>;
};

export interface CreateBundleDiffInput {
  baseBundleId: string;
  bundleId: string;
}

export interface CreateBundleDiffDependencies {
  databasePlugin: DatabasePlugin;
  storagePlugin: StoragePlugin | null;
}

const HBC_ASSET_PATH_RE = /\.bundle$/;

const isBundleManifest = (value: unknown): value is BundleManifest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const manifest = value as {
    bundleId?: unknown;
    assets?: unknown;
  };

  if (typeof manifest.bundleId !== "string") {
    return false;
  }

  if (!manifest.assets || typeof manifest.assets !== "object") {
    return false;
  }

  return Object.values(manifest.assets as Record<string, unknown>).every(
    (asset) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        return false;
      }

      const manifestAsset = asset as {
        fileHash?: unknown;
        signature?: unknown;
      };

      return (
        typeof manifestAsset.fileHash === "string" &&
        (manifestAsset.signature === undefined ||
          typeof manifestAsset.signature === "string")
      );
    },
  );
};

const createChildStorageUri = (
  baseStorageUri: string,
  relativePath: string,
) => {
  const baseUrl = new URL(baseStorageUri);
  const normalizedBasePath = baseUrl.pathname.replace(/\/+$/, "");
  const relativeSegments = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));

  baseUrl.pathname = `${normalizedBasePath}/${relativeSegments.join("/")}`;
  return baseUrl.toString();
};

const getRelativeStorageDir = (relativePath: string) => {
  const normalized = relativePath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "" : dirname;
};

async function resolveStorageDownloadUrl(
  storageUri: string,
  storagePlugin: StoragePlugin | null,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    return storageUri;
  }

  if (!storagePlugin) {
    throw new Error("Storage plugin is not configured");
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  const { fileUrl } = await storagePlugin.getDownloadUrl(storageUri);
  if (!fileUrl) {
    throw new Error("Storage plugin returned empty fileUrl");
  }

  return fileUrl;
}

async function fetchManifest(
  bundle: Bundle,
  storagePlugin: StoragePlugin | null,
): Promise<BundleManifest> {
  const manifestStorageUri = getManifestStorageUri(bundle);
  if (!manifestStorageUri) {
    throw new Error(`Bundle ${bundle.id} does not have manifest metadata`);
  }

  const manifestUrl = await resolveStorageDownloadUrl(
    manifestStorageUri,
    storagePlugin,
  );
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Failed to download manifest for bundle ${bundle.id}`);
  }

  const payload = (await response.json()) as unknown;
  if (!isBundleManifest(payload)) {
    throw new Error(`Invalid manifest payload for bundle ${bundle.id}`);
  }

  return payload;
}

function resolveHbcAssetPath(manifest: BundleManifest) {
  const assetPath = Object.keys(manifest.assets)
    .sort((left, right) => left.localeCompare(right))
    .find((candidate) => HBC_ASSET_PATH_RE.test(candidate));

  if (!assetPath) {
    throw new Error("No Hermes bundle asset found in manifest");
  }

  return assetPath;
}

async function fetchAssetBytes(
  bundle: Bundle,
  assetPath: string,
  storagePlugin: StoragePlugin | null,
) {
  const assetBaseStorageUri = getAssetBaseStorageUri(bundle);
  if (!assetBaseStorageUri) {
    throw new Error(`Bundle ${bundle.id} does not have asset storage metadata`);
  }

  const assetStorageUri = createChildStorageUri(assetBaseStorageUri, assetPath);
  const assetUrl = await resolveStorageDownloadUrl(
    assetStorageUri,
    storagePlugin,
  );
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download asset ${assetPath} for bundle ${bundle.id}`,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function getFileHash(filePath: string) {
  const file = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(file).digest("hex");
}

export async function createBundleDiff(
  { baseBundleId, bundleId }: CreateBundleDiffInput,
  deps: CreateBundleDiffDependencies,
) {
  if (!deps.storagePlugin) {
    throw new Error("Storage plugin is not configured");
  }

  if (baseBundleId === bundleId) {
    throw new Error("Base bundle must be different from the target bundle");
  }

  const baseBundle = await deps.databasePlugin.getBundleById(baseBundleId);
  const targetBundle = await deps.databasePlugin.getBundleById(bundleId);

  if (!baseBundle || !targetBundle) {
    throw new Error("Bundle not found");
  }

  if (baseBundle.platform !== targetBundle.platform) {
    throw new Error("Base bundle platform must match the target bundle");
  }

  if (baseBundle.id.localeCompare(targetBundle.id) >= 0) {
    throw new Error("Base bundle must be older than the target bundle");
  }

  const [baseManifest, targetManifest] = await Promise.all([
    fetchManifest(baseBundle, deps.storagePlugin),
    fetchManifest(targetBundle, deps.storagePlugin),
  ]);

  const baseAssetPath = resolveHbcAssetPath(baseManifest);
  const targetAssetPath = resolveHbcAssetPath(targetManifest);

  if (baseAssetPath !== targetAssetPath) {
    throw new Error("Base and target Hermes asset paths do not match");
  }

  const baseAssetHash = baseManifest.assets[baseAssetPath]?.fileHash;
  const targetAssetHash = targetManifest.assets[targetAssetPath]?.fileHash;

  if (!baseAssetHash || !targetAssetHash) {
    throw new Error("Hermes asset hash is missing from manifest");
  }

  if (baseAssetHash === targetAssetHash) {
    throw new Error("Hermes bundle is unchanged; no diff patch is required");
  }

  const [baseBytes, targetBytes] = await Promise.all([
    fetchAssetBytes(baseBundle, baseAssetPath, deps.storagePlugin),
    fetchAssetBytes(targetBundle, targetAssetPath, deps.storagePlugin),
  ]);

  const patchBytes = await hdiff(baseBytes, targetBytes);
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-console-bsdiff-"),
  );
  const patchFilename = `${path.posix.basename(targetAssetPath)}.bsdiff`;
  const patchPath = path.join(workDir, patchFilename);
  const previousPatchStorageUri = getPatchStorageUri(targetBundle);

  try {
    await fs.writeFile(patchPath, patchBytes);

    const uploadKey = [
      targetBundle.id,
      "patches",
      baseBundle.id,
      getRelativeStorageDir(targetAssetPath),
    ]
      .filter(Boolean)
      .join("/");
    const patchUpload = await deps.storagePlugin.upload(uploadKey, patchPath);
    const patchFileHash = await getFileHash(patchPath);

    await deps.databasePlugin.updateBundle(targetBundle.id, {
      patchBaseBundleId: baseBundle.id,
      patchBaseFileHash: baseAssetHash,
      patchFileHash,
      patchStorageUri: patchUpload.storageUri,
    });
    await deps.databasePlugin.commitBundle();

    if (
      previousPatchStorageUri &&
      previousPatchStorageUri !== patchUpload.storageUri
    ) {
      await deps.storagePlugin.delete(previousPatchStorageUri).catch(() => {});
    }

    const updatedBundle = await deps.databasePlugin.getBundleById(
      targetBundle.id,
    );
    if (!updatedBundle) {
      throw new Error("Updated bundle not found");
    }

    return updatedBundle;
  } finally {
    await fs.rm(workDir, { force: true, recursive: true });
  }
}
