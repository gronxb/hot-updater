import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { brotliDecompress } from "node:zlib";

import { hdiff } from "@hot-updater/bsdiff";
import {
  getAssetBaseStorageUri,
  getBundlePatch,
  getBundlePatches,
  getManifestStorageUri,
} from "@hot-updater/core";
import type {
  Bundle,
  DatabasePlugin,
  NodeStoragePlugin,
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
  storagePlugin: NodeStoragePlugin | null;
}

export interface CreateBundleDiffOptions {
  makePrimary?: boolean;
}

const HBC_ASSET_PATH_RE = /\.bundle$/;
const BR_COMPRESSED_ASSET_PATH_RE = /(^|\/)index\.[^/]+\.bundle$/;
const HOT_UPDATER_DOWNLOAD_DIR_PREFIX = "downloads-";
const decompressBrotli = promisify(brotliDecompress);

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

async function downloadFromUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download storage object: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function downloadStorageBytes(
  storageUri: string,
  storagePlugin: NodeStoragePlugin | null,
) {
  const protocol = new URL(storageUri).protocol.replace(":", "");

  if (protocol === "http" || protocol === "https") {
    return downloadFromUrl(storageUri);
  }

  if (!storagePlugin) {
    throw new Error("Storage plugin is not configured");
  }

  if (storagePlugin.supportedProtocol !== protocol) {
    throw new Error(`No storage plugin for protocol: ${protocol}`);
  }

  const downloadRoot = path.join(process.cwd(), ".hot-updater");
  await fs.mkdir(downloadRoot, { recursive: true });
  const workDir = await fs.mkdtemp(
    path.join(downloadRoot, HOT_UPDATER_DOWNLOAD_DIR_PREFIX),
  );
  const filename = path.basename(new URL(storageUri).pathname) || randomUUID();
  const filePath = path.join(workDir, filename);

  try {
    await storagePlugin.profiles.node.downloadFile(storageUri, filePath);
    return new Uint8Array(await fs.readFile(filePath));
  } finally {
    await fs.rm(workDir, { force: true, recursive: true });
  }
}

async function fetchManifest(
  bundle: Bundle,
  storagePlugin: NodeStoragePlugin | null,
): Promise<BundleManifest> {
  const manifestStorageUri = getManifestStorageUri(bundle);
  if (!manifestStorageUri) {
    throw new Error(`Bundle ${bundle.id} does not have manifest metadata`);
  }

  const manifestBytes = await downloadStorageBytes(
    manifestStorageUri,
    storagePlugin,
  );

  const payload = JSON.parse(
    new TextDecoder().decode(manifestBytes),
  ) as unknown;
  if (!isBundleManifest(payload)) {
    throw new Error(`Invalid manifest payload for bundle ${bundle.id}`);
  }

  return payload;
}

function resolveHbcAssetPath(manifest: BundleManifest) {
  const candidates = Object.keys(manifest.assets)
    .sort((left, right) => left.localeCompare(right))
    .filter((candidate) => HBC_ASSET_PATH_RE.test(candidate));

  if (candidates.length === 0) {
    throw new Error("No Hermes bundle asset found in manifest");
  }
  if (candidates.length > 1) {
    throw new Error(
      `Expected exactly one Hermes bundle asset in manifest, found ${candidates.length}: ${candidates.join(", ")}`,
    );
  }

  return candidates[0];
}

async function fetchAssetBytes(
  bundle: Bundle,
  assetPath: string,
  storagePlugin: NodeStoragePlugin | null,
) {
  const assetBaseStorageUri = getAssetBaseStorageUri(bundle);
  if (!assetBaseStorageUri) {
    throw new Error(`Bundle ${bundle.id} does not have asset storage metadata`);
  }

  if (BR_COMPRESSED_ASSET_PATH_RE.test(assetPath)) {
    const compressedAssetStorageUri = createChildStorageUri(
      assetBaseStorageUri,
      `${assetPath}.br`,
    );

    let compressedBytes: Uint8Array | null = null;
    try {
      compressedBytes = await downloadStorageBytes(
        compressedAssetStorageUri,
        storagePlugin,
      );
    } catch {
      // Older deployments stored manifest assets uncompressed.
    }

    if (compressedBytes) {
      return new Uint8Array(await decompressBrotli(compressedBytes));
    }
  }

  const assetStorageUri = createChildStorageUri(assetBaseStorageUri, assetPath);
  return downloadStorageBytes(assetStorageUri, storagePlugin);
}

async function getFileHash(filePath: string) {
  const file = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(file).digest("hex");
}

function buildNextPatchState({
  currentBundle,
  nextPatch,
  makePrimary,
}: {
  currentBundle: Bundle;
  nextPatch: NonNullable<ReturnType<typeof getBundlePatch>>;
  makePrimary: boolean;
}) {
  const existingPatches = getBundlePatches(currentBundle).filter(
    (patch) => patch.baseBundleId !== nextPatch.baseBundleId,
  );
  const orderedPatches = makePrimary
    ? [nextPatch, ...existingPatches]
    : [...existingPatches, nextPatch];
  const primaryPatch = orderedPatches[0] ?? nextPatch;

  return {
    patches: orderedPatches,
    primaryPatch,
  };
}

export async function createBundleDiff(
  { baseBundleId, bundleId }: CreateBundleDiffInput,
  deps: CreateBundleDiffDependencies,
  options: CreateBundleDiffOptions = {},
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
  const previousPatch = getBundlePatch(targetBundle, baseBundle.id);

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
    const patchUpload = await deps.storagePlugin.profiles.node.upload(
      uploadKey,
      patchPath,
    );
    const patchFileHash = await getFileHash(patchPath);

    const nextPatch = {
      baseBundleId: baseBundle.id,
      baseFileHash: baseAssetHash,
      patchFileHash,
      patchStorageUri: patchUpload.storageUri,
    };
    const nextState = buildNextPatchState({
      currentBundle: targetBundle,
      nextPatch,
      makePrimary: options.makePrimary ?? true,
    });

    await deps.databasePlugin.updateBundle(targetBundle.id, {
      patches: nextState.patches,
      patchBaseBundleId: nextState.primaryPatch.baseBundleId,
      patchBaseFileHash: nextState.primaryPatch.baseFileHash,
      patchFileHash: nextState.primaryPatch.patchFileHash,
      patchStorageUri: nextState.primaryPatch.patchStorageUri,
    });
    await deps.databasePlugin.commitBundle();

    if (
      previousPatch?.patchStorageUri &&
      previousPatch.patchStorageUri !== patchUpload.storageUri
    ) {
      await deps.storagePlugin.profiles.node
        .delete(previousPatch.patchStorageUri)
        .catch(() => {
          return;
        });
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
